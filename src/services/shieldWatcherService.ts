import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AccountService } from './accountService';
import { QuotaService } from './quotaService';
import { AutoSwitchService } from './autoSwitchService';

export class ShieldWatcherService implements vscode.Disposable {
  private static instance: ShieldWatcherService;
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer?: NodeJS.Timeout;
  private isDisposed = false;

  private constructor(
    private accountService: AccountService,
    private quotaService: QuotaService,
    private autoSwitchService: AutoSwitchService
  ) {
    this.setupWatchers();
  }

  public static initialize(
    accountService: AccountService,
    quotaService: QuotaService,
    autoSwitchService: AutoSwitchService
  ): ShieldWatcherService {
    if (!ShieldWatcherService.instance) {
      ShieldWatcherService.instance = new ShieldWatcherService(
        accountService,
        quotaService,
        autoSwitchService
      );
    }
    return ShieldWatcherService.instance;
  }

  public static getInstance(): ShieldWatcherService {
    return ShieldWatcherService.instance;
  }

  private setupWatchers(): void {
    const home = os.homedir();
    const shieldDir = path.join(home, '.antigravity_shield');
    if (!fs.existsSync(shieldDir)) {
      return;
    }

    const accountsDir = path.join(shieldDir, 'accounts');
    const accountsJson = path.join(shieldDir, 'accounts.json');

    // Watch accounts.json
    try {
      if (fs.existsSync(accountsJson)) {
        const w1 = fs.watch(accountsJson, (_event) => this.onFileChanged());
        this.watchers.push(w1);
      }
    } catch (e) {
      console.warn('[ShieldWatcher] Could not watch accounts.json:', e);
    }

    // Watch accounts directory for individual account JSON changes
    try {
      if (fs.existsSync(accountsDir)) {
        const w2 = fs.watch(accountsDir, (_event, filename) => {
          if (!filename || filename.endsWith('.json')) {
            this.onFileChanged();
          }
        });
        this.watchers.push(w2);
      }
    } catch (e) {
      console.warn('[ShieldWatcher] Could not watch accounts dir:', e);
    }
  }

  private onFileChanged(): void {
    if (this.isDisposed) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Debounce 250ms to allow multi-file batch writes by Shield
    this.debounceTimer = setTimeout(async () => {
      try {
        console.log('[ShieldWatcher] Detected disk change in Shield accounts. Auto-reloading...');
        const reloaded = await this.accountService.reloadFromDiskSilently();
        if (reloaded) {
          this.quotaService.notifyQuotasUpdated();
          await this.autoSwitchService.evaluateQuotasAndRotateIfNeeded();
        }
      } catch (err) {
        console.error('[ShieldWatcher] Error handling disk change:', err);
      }
    }, 250);
  }

  public dispose(): void {
    this.isDisposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
  }
}
