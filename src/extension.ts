import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AccountService } from './services/accountService';
import { QuotaService } from './services/quotaService';
import { ConversationService } from './services/conversationService';
import { AutoSwitchService } from './services/autoSwitchService';
import { NetworkWatchdogService } from './services/networkWatchdogService';
import { ShieldWatcherService } from './services/shieldWatcherService';
import { AccountTreeProvider } from './providers/accountTreeProvider';
import { HistoryTreeProvider } from './providers/historyTreeProvider';
import { QuotaWebviewProvider } from './providers/quotaWebviewProvider';
import { StatusBarManager } from './ui/statusBar';
import { ConversationSession } from './types';
import { ShieldBridge } from './bridge/shieldBridge';
import { ExtensionUpdateService } from './services/extensionUpdateService';

let quotaIntervalTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('[Antigravity Toolkit 2.0] Activating extension...');

  // 1. Initialize core services
  const accountService = AccountService.initialize(context);
  const quotaService = QuotaService.getInstance();
  const conversationService = ConversationService.getInstance();
  conversationService.initWatchers();
  const autoSwitchService = AutoSwitchService.initialize(accountService, quotaService);
  const networkWatchdog = NetworkWatchdogService.initialize();
  const shieldWatcher = ShieldWatcherService.initialize(accountService, quotaService, autoSwitchService);
  const updateService = ExtensionUpdateService.getInstance();

  context.subscriptions.push(networkWatchdog);
  context.subscriptions.push(shieldWatcher);
  context.subscriptions.push(updateService.initBackgroundSchedule());
  context.subscriptions.push({ dispose: () => autoSwitchService.dispose() });
  context.subscriptions.push({ dispose: () => conversationService.disposeWatchers() });

  // 2. Initialize Webview Provider (Single Unified View)
  const quotaWebviewProvider = new QuotaWebviewProvider(
    context.extensionUri,
    quotaService,
    accountService,
    autoSwitchService,
    conversationService
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      QuotaWebviewProvider.viewType,
      quotaWebviewProvider
    )
  );

  // 3. Status Bar HUD
  const statusBar = new StatusBarManager(
    accountService,
    quotaService,
    autoSwitchService,
    networkWatchdog
  );
  context.subscriptions.push(statusBar);

  // 4. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityToolkit.refreshAll', async () => {
      quotaService.notifyQuotasUpdated();
      conversationService.refresh();
      await updateService.checkAndUpdate(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'antigravityToolkit.switchAccount',
      async (email?: string) => {
        if (email && typeof email === 'string') {
          await accountService.switchAccount(email);
          return;
        }

        // Display QuickPick for selection
        const accounts = accountService.getAccounts();
        if (accounts.length === 0) {
          const action = await vscode.window.showInformationMessage(
            'No accounts stored in Antigravity Toolkit. Sync from Shield or add account?',
            'Sync from Shield',
            'Add Manually'
          );
          if (action === 'Sync from Shield') {
            await accountService.syncFromShield();
          } else if (action === 'Add Manually') {
            await vscode.commands.executeCommand('antigravityToolkit.addAccount');
          }
          return;
        }

        const items = accounts.map((acc) => {
          const health = Math.round(accountService.getAccountHealth(acc));
          return {
            label: acc.email,
            description: acc.isActive ? '$(check) Active' : `[${health}% Quota Ready]`,
            detail: `Plan: ${acc.tier || 'Google AI Pro'} • Health: ${health}%`,
            account: acc,
          };
        });

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select an Antigravity account to switch into (Zero restart)',
        });

        if (selected) {
          await accountService.switchAccount(selected.account.email);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityToolkit.addAccount', async () => {
      const email = await vscode.window.showInputBox({
        prompt: 'Enter Google / Antigravity Account Email',
        placeHolder: 'user@example.com',
      });
      if (!email) return;

      const token = await vscode.window.showInputBox({
        prompt: 'Enter OAuth Access Token or Refresh Token (optional for local sync)',
        password: true,
      });

      await accountService.addOrUpdateAccount({
        id: email,
        email,
        isActive: true,
        token: {
          accessToken: token || '',
          refreshToken: token || '',
          expiryTimestamp: Date.now() + 3600 * 1000,
        },
      });

      vscode.window.showInformationMessage(`Account ${email} added.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityToolkit.syncWithShield', async () => {
      await accountService.syncFromShield();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityToolkit.toggleAutoSwitch', async () => {
      const current = autoSwitchService.isEnabled();
      await autoSwitchService.setEnabled(!current);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityToolkit.triggerAutoRotate', async () => {
      const rotated = await autoSwitchService.evaluateQuotasAndRotateIfNeeded();
      if (!rotated) {
        vscode.window.showInformationMessage('Current session quota is healthy (>2%). No rotation needed.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'antigravityToolkit.openConversation',
      async (session?: ConversationSession) => {
        if (session) {
          await conversationService.openTranscript(session);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityToolkit.openQuotaDashboard', () => {
      vscode.commands.executeCommand('antigravity.views.quota.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityToolkit.restartLanguageServer', async () => {
      const ok = await networkWatchdog.restartLanguageServerSilently();
      if (ok) {
        vscode.window.showInformationMessage('⚡ Antigravity AI Language Server restarted.');
      } else {
        vscode.window.showErrorMessage('Failed to restart Antigravity Language Server.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityToolkit.healAiConnection', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Auto-healing Antigravity AI connection...',
          cancellable: false,
        },
        async () => {
          await networkWatchdog.probeConnectivity();
          await networkWatchdog.restartLanguageServerSilently();
          vscode.window.showInformationMessage('⚡ Antigravity AI connection refreshed and healed.');
        }
      );
    })
  );

  // 5. Setup Background Polling Timer for Quotas (Silent real-time re-hydration)
  const config = vscode.workspace.getConfiguration('antigravityToolkit');
  const intervalSeconds = config.get<number>('quotaRefreshIntervalSeconds', 30);
  const pollIntervalMs = Math.max(15, intervalSeconds > 0 ? intervalSeconds : 30) * 1000;

  quotaIntervalTimer = setInterval(async () => {
    try {
      const active = accountService.getActiveAccount();
      const health = active ? accountService.getAccountHealth(active) : 100;
      if (health > 0 && health <= 10) {
        shieldBridge.refreshAccountQuota(active?.id || active?.email).catch(() => {});
      }

      const changed = await accountService.reloadFromDiskSilently();
      if (changed) {
        quotaService.notifyQuotasUpdated();
        await autoSwitchService.evaluateQuotasAndRotateIfNeeded();
      }
    } catch (e) {
      console.warn('[Antigravity Toolkit] Background quota sync error:', e);
    }
  }, pollIntervalMs);

  // 6. Proactive Heartbeat & Background Sync to Shield (1.5s interval for fast command pickup & auto-reconnect)
  const shieldBridge = ShieldBridge.getInstance();
  let lastShieldOnline: boolean | null = null;
  const sendHb = async () => {
    try {
      const active = accountService.getActiveAccount();
      const ok = await shieldBridge.sendHeartbeat(active?.email);
      if (lastShieldOnline !== null && lastShieldOnline !== ok) {
        console.log(`[Toolkit Bridge] Shield status changed: ${lastShieldOnline} -> ${ok}. Auto-refreshing UI...`);
        lastShieldOnline = ok;
        shieldBridge.resetDetectedBaseUrl();
        if (ok) {
          await accountService.reloadFromDiskSilently();
        }
        quotaService.notifyQuotasUpdated();
      } else if (lastShieldOnline === null) {
        lastShieldOnline = ok;
      }
    } catch {
      // ignore
    }
  };

  sendHb();
  heartbeatTimer = setInterval(sendHb, 1500);

  setTimeout(() => {
    accountService.syncFromShield().catch(() => {});
  }, 2000);

  // 7. Full-Duplex Two-Way Tunnel Listener (Shield -> IDE Zero-Reload Switch & Quota Updates)
  shieldBridge.startCommandListener(async (cmd) => {
    if (cmd && cmd.action === 'switch_account' && cmd.email) {
      console.log(`[Toolkit Tunnel] Received switch command for ${cmd.email} from Shield!`);
      await accountService.switchAccount(cmd.email);
      try {
        await vscode.commands.executeCommand('ag.switchAccountDirect', cmd.email);
      } catch {
        // switchboard might not be active, safe to ignore
      }
    } else if (cmd && (cmd.action === 'quota_updated' || cmd.action === 'refresh_quotas')) {
      console.log(`[Toolkit Tunnel] Received ${cmd.action} event from Shield! Auto-reloading...`);
      await accountService.reloadFromDiskSilently();
      quotaService.notifyQuotasUpdated();
      await autoSwitchService.evaluateQuotasAndRotateIfNeeded();
    }
  });

  // 8. Auto-load pending conversation if opened from another workspace (Immediate check)
  (async () => {
    try {
      const pendingFile = path.join(os.homedir(), '.gemini', 'pending_open_chat.json');
      if (!fs.existsSync(pendingFile)) return;

      const raw = fs.readFileSync(pendingFile, 'utf8');
      const data = JSON.parse(raw);
      if (!data || !data.title || Date.now() - (data.timestamp || 0) > 60000) return;

      const currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (
        data.workspacePath &&
        currentWorkspaceFolder &&
        path.normalize(currentWorkspaceFolder).toLowerCase() !== path.normalize(data.workspacePath).toLowerCase()
      ) {
        return;
      }

      // Valid pending chat found! Clean up file immediately
      try {
        fs.unlinkSync(pendingFile);
      } catch {}

      console.log(`[Antigravity Toolkit] Activating pending conversation "${data.title}" immediately...`);
      const cleanTitle = String(data.title).replace(/[\r\n\t]+/g, ' ').trim();
      const searchQuery = cleanTitle
        .replace(/\.{3,}$/, '')
        .replace(/[^\p{L}\p{N}\s\u200c\u200d]/gu, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
        .slice(0, 40);

      if (searchQuery) {
        await vscode.env.clipboard.writeText(searchQuery);
      }

      // Fast retry loop: wait until IDE workbench is ready to accept commands (max 5 seconds)
      const startTime = Date.now();
      const tryTriggerPicker = async () => {
        try {
          const commands = await vscode.commands.getCommands(true);
          const hasPickerCmd = commands.includes('antigravity.openConversationPicker') || commands.includes('openConversationPicker');
          if (hasPickerCmd || Date.now() - startTime > 3000) {
            // Launch automation concurrently
            conversationService.automatePasteAndSelect(searchQuery);

            // Trigger the conversation picker
            vscode.commands.executeCommand('antigravity.openConversationPicker').then(undefined, () => {
              vscode.commands.executeCommand('openConversationPicker').then(undefined, () => {});
            });
            return;
          }
        } catch {}

        if (Date.now() - startTime < 5000) {
          setTimeout(tryTriggerPicker, 150);
        }
      };

      // Start probing immediately with slight initial breath for workbench mount (250ms)
      setTimeout(tryTriggerPicker, 250);
    } catch (e) {
      console.warn('[Antigravity Toolkit] Error handling pending chat:', e);
    }
  })();

  console.log('[Antigravity Toolkit 2.0] Activated successfully.');
}

export function deactivate() {
  if (quotaIntervalTimer) {
    clearInterval(quotaIntervalTimer);
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  ShieldBridge.getInstance().stopCommandListener();
}
