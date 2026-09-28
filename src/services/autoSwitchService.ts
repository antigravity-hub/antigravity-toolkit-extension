import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AccountService } from './accountService';
import { QuotaService } from './quotaService';
import { Account, ModelQuota } from '../types';

export interface AutoSwitchStatus {
  enabled: boolean;
  thresholdPercent: number;
  cooldownMinutes: number;
  lastSwitchTimestamp: number;
  lastSwitchReason: string;
}

export class AutoSwitchService {
  private static instance: AutoSwitchService;
  private intervalTimer?: NodeJS.Timeout;
  private isChecking = false;
  private lastSwitchTimestamp = 0;
  private lastSwitchReason = '';
  private lastProactiveProbeTimestamp = 0;
  private enabled = true;

  private onDidChangeStatusEmitter = new vscode.EventEmitter<AutoSwitchStatus>();
  public readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;

  private constructor(
    private accountService: AccountService,
    private quotaService: QuotaService
  ) {
    this.loadConfiguration();
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityToolkit.autoSwitch')) {
        this.loadConfiguration();
      }
    });

    // Start background monitor
    this.startPolling();
  }

  public static initialize(
    accountService: AccountService,
    quotaService: QuotaService
  ): AutoSwitchService {
    if (!AutoSwitchService.instance) {
      AutoSwitchService.instance = new AutoSwitchService(accountService, quotaService);
    }
    return AutoSwitchService.instance;
  }

  public static getInstance(): AutoSwitchService {
    return AutoSwitchService.instance;
  }

  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('antigravityToolkit.autoSwitch');
    this.enabled = config.get<boolean>('enabled', true);
    this.emitStatus();
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    const config = vscode.workspace.getConfiguration('antigravityToolkit.autoSwitch');
    await config.update('enabled', enabled, vscode.ConfigurationTarget.Global);
    this.emitStatus();
    vscode.window.showInformationMessage(
      `Antigravity Auto-Rotate is now ${enabled ? 'ENABLED (Auto-switching on ≤5% quota)' : 'DISABLED'}`
    );
  }

  public getStatus(): AutoSwitchStatus {
    const config = vscode.workspace.getConfiguration('antigravityToolkit.autoSwitch');
    return {
      enabled: this.enabled,
      thresholdPercent: config.get<number>('quotaThresholdPercent', 5),
      cooldownMinutes: config.get<number>('cooldownMinutes', 3),
      lastSwitchTimestamp: this.lastSwitchTimestamp,
      lastSwitchReason: this.lastSwitchReason,
    };
  }

  private getPreferredLanguage(): string {
    try {
      const home = os.homedir();
      const cfgPath = path.join(home, '.antigravity_shield', 'gui_config.json');
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data.language === 'string') {
          return data.language.toLowerCase();
        }
      }
    } catch {}

    const envLang = (vscode.env.language || '').toLowerCase();
    if (envLang.startsWith('fa')) return 'fa';
    if (envLang.startsWith('zh')) return 'zh';
    return 'en';
  }

  private emitStatus(): void {
    this.onDidChangeStatusEmitter.fire(this.getStatus());
  }

  private startPolling(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }

    // Fast zero-downtime proactive quota monitoring
    this.intervalTimer = setInterval(() => {
      this.evaluateQuotasAndRotateIfNeeded();
    }, 5000);
  }

  /**
   * Core autonomous decision engine:
   * Evaluates active account quotas and rotates to the best standby account
   * when quota drops below threshold (default 5%) or 5h rolling window/weekly limit is exhausted.
   */
  public async evaluateQuotasAndRotateIfNeeded(): Promise<boolean> {
    if (!this.enabled || this.isChecking) {
      return false;
    }

    this.isChecking = true;
    try {
      // Re-hydrate directly from disk before evaluation to catch real-time Shield updates
      await this.accountService.reloadFromDiskSilently();

      const activeAccount = this.accountService.getActiveAccount();
      if (!activeAccount) {
        return false;
      }

      const config = vscode.workspace.getConfiguration('antigravityToolkit.autoSwitch');
      const threshold = config.get<number>('quotaThresholdPercent', 5);
      const now = Date.now();

      const quotas = await this.quotaService.getActiveQuotas();
      if (quotas.length === 0) {
        return false;
      }

      // Determine if active session has reached critical depletion:
      // 0. Active account became unusable in Shield (verification required or disabled)
      // 1. Overall active account health <= threshold (e.g. 5h limit or weekly exhausted)
      // 2. Any primary model has <= threshold remaining quota
      // 3. OR 5-hour rolling window has <= 2% time remaining (< 6 minutes) and high usage
      let isCritical = false;
      let criticalReason = '';

      if (!this.accountService.isAccountUsable(activeAccount)) {
        isCritical = true;
        if (activeAccount.validationBlocked) {
          criticalReason = `Active account requires Google verification in Shield (${activeAccount.validationBlockedReason || 'Verification Required'})`;
        } else if (activeAccount.disabled || activeAccount.proxyDisabled) {
          criticalReason = `Active account was turned off/disabled in Shield`;
        } else {
          criticalReason = `Active account is restricted in Shield`;
        }
      }

      const activeHealth = this.accountService.getAccountHealth(activeAccount);

      // Adaptive Low-Quota Proactive Probe:
      // When active session quota enters the critical danger zone (<= 20% and > 0%),
      // trigger a fast quota check on Shield every 30 seconds so 0% exhaustion is caught live!
      if (activeHealth > 0 && activeHealth <= 20) {
        if (now - this.lastProactiveProbeTimestamp >= 30000) {
          this.lastProactiveProbeTimestamp = now;
          console.log(
            `[AutoSwitch] Active session ${activeAccount.email} is in low-quota zone (${activeHealth}%). Requesting live sync from Shield...`
          );
          import('../bridge/shieldBridge').then(({ ShieldBridge }) => {
            ShieldBridge.getInstance()
              .refreshAccountQuota(activeAccount.id || activeAccount.email)
              .catch(() => {});
          });
        }
      }

      if (!isCritical) {
        if (activeHealth <= threshold) {
          isCritical = true;
          criticalReason = `Account quota health depleted (${activeHealth}% remaining)`;
        } else {
          for (const q of quotas) {
            const remaining = typeof q.remainingQuota === 'number' ? q.remainingQuota : Math.max(0, 100 - q.usagePercentage);
            if (remaining <= threshold) {
              isCritical = true;
              criticalReason = `${q.displayName} quota exhausted (${remaining}% left)`;
              break;
            }

            // Rolling 5-hour window duration remaining check
            if (q.windowType === 'rolling_5h' && q.resetTimeMs > 0) {
              const timeRemainingMs = Math.max(0, q.resetTimeMs - now);
              // 2% of 5 hours is 6 minutes (360,000 ms)
              const fiveHoursMs = 5 * 60 * 60 * 1000;
              const timePercent = (timeRemainingMs / fiveHoursMs) * 100;

              if (timePercent <= 2 && remaining < 15) {
                isCritical = true;
                criticalReason = `${q.displayName} 5-hour window expiring (${Math.round(timeRemainingMs / 60000)}m left, ${remaining}% quota)`;
                break;
              }
            }
          }
        }
      }

      if (!isCritical) {
        return false;
      }

      // Find the next best account with healthy quota
      const bestCandidate = this.accountService.getBestNextAccount(activeAccount.email);
      if (!bestCandidate) {
        console.log('[AutoSwitch] Critical quota detected, but no eligible standby accounts found.');
        return false;
      }

      // Perform automatic zero-downtime hot-swap
      console.log(
        `[AutoSwitch] Triggering auto-switch from ${activeAccount.email} to ${bestCandidate.account.email} due to: ${criticalReason}`
      );

      this.lastSwitchTimestamp = now;
      this.lastSwitchReason = criticalReason;

      const success = await this.accountService.switchAccount(bestCandidate.account.email, true);
      if (success) {
        this.emitStatus();

        const notify = config.get<boolean>('notifyOnSwitch', true);
        if (notify) {
          const lang = this.getPreferredLanguage();
          let notificationTitle = `Switched from ${activeAccount.email} to ${bestCandidate.account.email} due to token exhaustion.`;
          let statusText = `⚡ Switched to ${bestCandidate.account.email} (Quota depleted)`;

          if (lang === 'fa') {
            notificationTitle = `سوییچ شد از ${activeAccount.email} به ${bestCandidate.account.email} بخاطر اتمام توکن`;
            statusText = `⚡ سوییچ شد به ${bestCandidate.account.email} (اتمام توکن)`;
          } else if (lang.startsWith('zh')) {
            notificationTitle = `已从 ${activeAccount.email} 切换至 ${bestCandidate.account.email}（Token 配额已用尽）`;
            statusText = `⚡ 已切换至 ${bestCandidate.account.email}（配额用尽）`;
          }

          // Subtle corner toast with 8-second auto-dismissal
          vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: notificationTitle,
              cancellable: false,
            },
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 8000));
            }
          );
          vscode.window.setStatusBarMessage(statusText, 8000);
        }
        return true;
      }

      return false;
    } catch (err) {
      console.error('[AutoSwitch] Error evaluating quotas:', err);
      return false;
    } finally {
      this.isChecking = false;
    }
  }

  public dispose(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }
    this.onDidChangeStatusEmitter.dispose();
  }
}
