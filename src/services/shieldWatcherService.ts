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
    const bridgeJson = path.join(shieldDir, 'bridge_info.json');
    const guiConfigJson = path.join(shieldDir, 'gui_config.json');

    // Watch bridge_info.json for live port/process restarts
    try {
      if (fs.existsSync(bridgeJson)) {
        const w0 = fs.watch(bridgeJson, (_event) => this.onFileChanged());
        this.watchers.push(w0);
      }
    } catch (e) {
      console.warn('[ShieldWatcher] Could not watch bridge_info.json:', e);
    }

    // Watch gui_config.json for live config/language changes
    try {
      if (fs.existsSync(guiConfigJson)) {
        const wConfig = fs.watch(guiConfigJson, (_event) => this.onFileChanged());
        this.watchers.push(wConfig);
      }
    } catch (e) {
      console.warn('[ShieldWatcher] Could not watch gui_config.json:', e);
    }

    // Watch parent dir to catch creation of bridge_info.json, accounts.json, or gui_config.json
    try {
      const wDir = fs.watch(shieldDir, (_event, filename) => {
        if (filename === 'bridge_info.json' || filename === 'accounts.json' || filename === 'gui_config.json') {
          this.onFileChanged();
        }
      });
      this.watchers.push(wDir);
    } catch (e) {
      console.warn('[ShieldWatcher] Could not watch shieldDir:', e);
    }

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
        console.log('[ShieldWatcher] Detected disk change in Shield state. Auto-reloading...');
        const { ShieldBridge } = await import('../bridge/shieldBridge');
        ShieldBridge.getInstance().resetDetectedBaseUrl();
        const reloaded = await this.accountService.reloadFromDiskSilently();
        this.quotaService.notifyQuotasUpdated();
        if (reloaded) {
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
