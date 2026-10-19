import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AccountService } from './accountService';
import { QuotaService } from './quotaService';
import { Account, ModelQuota } from '../types';
import { t } from '../utils/i18n';

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
  private consecutiveProbeFailures = 0;
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
        } else if (activeAccount.disabled) {
          criticalReason = `Active account was turned off/disabled in Shield`;
        } else {
          criticalReason = `Active account is restricted in Shield`;
        }
      }

      const activeHealth = this.accountService.getAccountHealth(activeAccount);

      // Proactive Quota Probe:
      // Keep quota sync alive from Shield during active IDE usage.
      // Skip if account is disabled or blocked in Shield to prevent hammering with dead requests.
      const isUsable = this.accountService.isAccountUsable(activeAccount);
      if (isUsable) {
        // Base interval: 45s for danger zone (<= 25%), 120s for normal (> 25%)
        const baseIntervalMs = activeHealth > 0 && activeHealth <= 25 ? 45000 : 120000;
        // Exponential backoff if probes fail (multiplier up to 5x: 45s -> 67s -> 101s -> 151s -> 225s)
        const backoffMultiplier = Math.min(5, Math.pow(1.5, this.consecutiveProbeFailures));
        const probeIntervalMs = Math.round(baseIntervalMs * backoffMultiplier);

        if (now - this.lastProactiveProbeTimestamp >= probeIntervalMs) {
          this.lastProactiveProbeTimestamp = now;
          console.log(
            `[AutoSwitch] Proactive quota probe for ${activeAccount.email} (Health: ${activeHealth}%, Backoff: ${backoffMultiplier.toFixed(1)}x). Requesting live sync from Shield...`
          );
          import('../bridge/shieldBridge').then(async ({ ShieldBridge }) => {
            try {
              const ok = await ShieldBridge.getInstance().refreshAccountQuota(
                activeAccount.id || activeAccount.email
              );
              if (ok) {
                this.consecutiveProbeFailures = 0;
              } else {
                this.consecutiveProbeFailures++;
              }
            } catch {
              this.consecutiveProbeFailures++;
            }
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
        const transcriptQuotaError = this.checkRecentTranscriptForQuotaError();
        if (transcriptQuotaError) {
          isCritical = true;
          criticalReason = transcriptQuotaError;
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
          const notificationTitle = t('switchedAccountToast', {
            from: activeAccount.email,
            to: bestCandidate.account.email,
          });
          const statusText = t('switchedAccountStatus', {
            to: bestCandidate.account.email,
          });

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

  /**
   * Emergency fast-failover hook for intercepting direct Google Cloud quota exhaustion errors
   * (e.g. "Individual quota reached. Resets in 2h7m30s").
   */
  public async handleDirectQuotaDepletion(errorText: string): Promise<boolean> {
    if (!this.enabled) return false;
    const now = Date.now();
    if (now - this.lastSwitchTimestamp < 10000) return false;

    await this.accountService.reloadFromDiskSilently();
    const activeAccount = this.accountService.getActiveAccount();
    if (!activeAccount) return false;

    console.warn(`[AutoSwitch] 🚨 Direct Quota Depletion Intercepted: "${errorText}". Initiating instant emergency failover!`);

    let resetNotice = 'Individual quota reached on Google Cloud';
    const resetMatch = errorText.match(/resets? in\s+([^\.,;\]\n>]+)/i);
    if (resetMatch && resetMatch[1]) {
      resetNotice += ` (Resets in ${resetMatch[1].trim()})`;
    }

    const bestCandidate = this.accountService.getBestNextAccount(activeAccount.email);
    if (!bestCandidate) {
      console.error('[AutoSwitch] Emergency failover desired, but no eligible standby account found.');
      return false;
    }

    this.lastSwitchTimestamp = now;
    this.lastSwitchReason = resetNotice;

    const success = await this.accountService.switchAccount(bestCandidate.account.email, true);
    if (success) {
      this.emitStatus();
      vscode.window.showWarningMessage(
        `⚡ Antigravity Auto-Rotate: Switched from ${activeAccount.email} to ${bestCandidate.account.email} (${resetNotice})`
      );
    }
    return success;
  }

  private checkRecentTranscriptForQuotaError(): string | null {
    try {
      const home = os.homedir();
      const brainDir = path.join(home, '.gemini', 'antigravity-ide', 'brain');
      if (!fs.existsSync(brainDir)) return null;

      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      let newestDir = '';
      let newestMtime = 0;
      for (const ent of entries) {
        if (ent.isDirectory()) {
          const full = path.join(brainDir, ent.name);
          const stat = fs.statSync(full);
          if (stat.mtimeMs > newestMtime) {
            newestMtime = stat.mtimeMs;
            newestDir = full;
          }
        }
      }

      if (!newestDir) return null;
      const transcriptPath = path.join(newestDir, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) return null;

      const stat = fs.statSync(transcriptPath);
      // Only check if modified in the last 60 seconds
      if (Date.now() - stat.mtimeMs > 60000) return null;

      const fd = fs.openSync(transcriptPath, 'r');
      const tailSize = Math.min(stat.size, 8192);
      const tailBuf = Buffer.alloc(tailSize);
      fs.readSync(fd, tailBuf, 0, tailSize, stat.size - tailSize);
      fs.closeSync(fd);

      const tailStr = tailBuf.toString('utf8');
      if (/individual quota reached/i.test(tailStr)) {
        const match = tailStr.match(/Individual quota reached[^\n"]*/i);
        return match ? match[0] : 'Individual quota reached';
      }
    } catch {}
    return null;
  }

  public dispose(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }
    this.onDidChangeStatusEmitter.dispose();
  }
}
