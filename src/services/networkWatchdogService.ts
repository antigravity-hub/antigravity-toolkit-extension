import * as vscode from 'vscode';
import * as https from 'https';

export type NetworkStatus = 'online' | 'offline' | 'reconnecting';

export class NetworkWatchdogService implements vscode.Disposable {
  private static instance: NetworkWatchdogService | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private status: NetworkStatus = 'online';
  private consecutiveFailures = 0;
  private isRestarting = false;
  private lastAutoHealTimestamp = 0;
  private readonly onDidChangeStatusEmitter = new vscode.EventEmitter<NetworkStatus>();
  public readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;

  private constructor() {
    this.ensurePersistentLanguageServerConfig().catch(() => {});
    this.startWatchdog();
  }

  public static initialize(): NetworkWatchdogService {
    if (!NetworkWatchdogService.instance) {
      NetworkWatchdogService.instance = new NetworkWatchdogService();
    }
    return NetworkWatchdogService.instance;
  }

  public static getInstance(): NetworkWatchdogService {
    if (!NetworkWatchdogService.instance) {
      return NetworkWatchdogService.initialize();
    }
    return NetworkWatchdogService.instance;
  }

  public getStatus(): NetworkStatus {
    return this.status;
  }

  public isOnline(): boolean {
    return this.status === 'online';
  }

  /**
   * Silently guarantees that 'antigravity.persistentLanguageServer' is set to true
   * so the Language Server survives window reloads and doesn't get hard-killed by transient pipe disconnects.
   */
  public async ensurePersistentLanguageServerConfig(): Promise<void> {
    try {
      const agConfig = vscode.workspace.getConfiguration('antigravity');
      const isPersistent = agConfig.get<boolean>('persistentLanguageServer');
      if (isPersistent !== true) {
        console.log('[NetworkWatchdog] Auto-enabling antigravity.persistentLanguageServer globally...');
        await agConfig.update('persistentLanguageServer', true, vscode.ConfigurationTarget.Global);
      }
    } catch (err) {
      console.warn('[NetworkWatchdog] Could not set persistentLanguageServer:', err);
    }
  }

  /**
   * Start periodic connectivity probing.
   */
  public startWatchdog(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }

    const config = vscode.workspace.getConfiguration('antigravityToolkit');
    const enabled = config.get<boolean>('networkWatchdog.enabled', true);
    if (!enabled) {
      console.log('[NetworkWatchdog] Network Watchdog is disabled by user setting.');
      return;
    }

    const intervalSeconds = Math.max(3, config.get<number>('networkWatchdog.checkIntervalSeconds', 6));

    // Initial probe
    this.probeConnectivity();

    this.checkTimer = setInterval(() => {
      this.probeConnectivity();
    }, intervalSeconds * 1000);
  }

  /**
   * Probes Google / connectivity endpoints to test if internet / VPN is operational.
   */
  public async probeConnectivity(): Promise<boolean> {
    const isReachable = await this.checkHttpReachability();

    if (isReachable) {
      const wasOffline = this.status === 'offline' || this.consecutiveFailures >= 3;
      this.consecutiveFailures = 0;

      if (wasOffline) {
        console.log('[NetworkWatchdog] Connectivity restored after disconnection!');
        this.status = 'reconnecting';
        this.onDidChangeStatusEmitter.fire(this.status);
        await this.handleReconnection();
      } else {
        if (this.status !== 'online') {
          this.status = 'online';
          this.onDidChangeStatusEmitter.fire(this.status);
        }
      }
      return true;
    } else {
      this.consecutiveFailures++;
      // Require 3 consecutive failures (~18s) before marking offline to avoid false alarms from transient jitter
      if (this.consecutiveFailures >= 3 && this.status !== 'offline') {
        console.warn('[NetworkWatchdog] Network appears offline (consecutive failures: ' + this.consecutiveFailures + ').');
        this.status = 'offline';
        this.onDidChangeStatusEmitter.fire(this.status);
      }
      return false;
    }
  }

  /**
   * Handle state change when connection is re-established after VPN drop.
   */
  private async handleReconnection(): Promise<void> {
    if (this.isRestarting) return;
    this.isRestarting = true;

    const config = vscode.workspace.getConfiguration('antigravityToolkit');
    const autoRestart = config.get<boolean>('networkWatchdog.autoRestartLanguageServer', true);

    try {
      // Stabilization grace period (2.5 seconds)
      console.log('[NetworkWatchdog] Waiting for network routing and TUN adapter to stabilize...');
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const confirmed = await this.checkHttpReachability();
      if (!confirmed) {
        console.warn('[NetworkWatchdog] Network still unstable after grace period. Postponing restart.');
        this.status = 'offline';
        this.onDidChangeStatusEmitter.fire(this.status);
        this.isRestarting = false;
        return;
      }

      this.status = 'online';
      this.onDidChangeStatusEmitter.fire(this.status);

      // Enforce 45s cooldown to prevent repeated restarts during network oscillation
      const now = Date.now();
      if (now - this.lastAutoHealTimestamp < 45000) {
        console.log('[NetworkWatchdog] Reconnected, but auto-heal cooldown active (45s). Skipping Language Server restart.');
        this.isRestarting = false;
        return;
      }
      this.lastAutoHealTimestamp = now;

      if (autoRestart) {
        console.log('[NetworkWatchdog] Auto-executing antigravity.restartLanguageServer...');
        await this.restartLanguageServerSilently();

        // Silent, non-intrusive status bar indicator
        vscode.window.setStatusBarMessage('⚡ Antigravity AI: Language Server auto-healed', 5000);

        const showPopup = config.get<boolean>('networkWatchdog.showNotifications', false);
        if (showPopup) {
          vscode.window
            .showInformationMessage(
              '⚡ Antigravity AI: Network restored & Language Server auto-healed.',
              'Restart Again'
            )
            .then((choice) => {
              if (choice === 'Restart Again') {
                vscode.commands.executeCommand('antigravity.restartLanguageServer');
              }
            });
        }
      }
    } catch (err) {
      console.error('[NetworkWatchdog] Error during auto-heal restart:', err);
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * Safely restarts the Antigravity Language Server via built-in command.
   */
  public async restartLanguageServerSilently(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.restartLanguageServer');
      return true;
    } catch (err) {
      console.warn('[NetworkWatchdog] antigravity.restartLanguageServer failed:', err);
      return false;
    }
  }

  /**
   * Lightweight HTTP GET to check connectivity.
   */
  private checkHttpReachability(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = https.get(
        'https://clients3.google.com/generate_204',
        {
          timeout: 5000,
          headers: { 'User-Agent': 'Antigravity-Toolkit-Watchdog' },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            res.resume();
            resolve(true);
          } else {
            res.resume();
            resolve(false);
          }
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.on('error', () => {
        resolve(false);
      });
    });
  }

  public dispose(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.onDidChangeStatusEmitter.dispose();
  }
}
