import * as vscode from 'vscode';
import { AccountService } from './services/accountService';
import { QuotaService } from './services/quotaService';
import { ConversationService } from './services/conversationService';
import { AutoSwitchService } from './services/autoSwitchService';
import { AccountTreeProvider } from './providers/accountTreeProvider';
import { HistoryTreeProvider } from './providers/historyTreeProvider';
import { QuotaWebviewProvider } from './providers/quotaWebviewProvider';
import { StatusBarManager } from './ui/statusBar';
import { ConversationSession } from './types';
import { ShieldBridge } from './bridge/shieldBridge';

let quotaIntervalTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('[Antigravity Toolkit 2.0] Activating extension...');

  // 1. Initialize core services
  const accountService = AccountService.initialize(context);
  const quotaService = QuotaService.getInstance();
  const conversationService = ConversationService.getInstance();
  const autoSwitchService = AutoSwitchService.initialize(accountService, quotaService);
  context.subscriptions.push({ dispose: () => autoSwitchService.dispose() });

  // 2. Initialize Tree & Webview Providers
  const accountTreeProvider = new AccountTreeProvider(accountService);
  vscode.window.registerTreeDataProvider(
    'antigravity.views.accounts',
    accountTreeProvider
  );

  const historyTreeProvider = new HistoryTreeProvider(conversationService);
  vscode.window.registerTreeDataProvider(
    'antigravity.views.conversations',
    historyTreeProvider
  );

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
  const statusBar = new StatusBarManager(accountService, quotaService, autoSwitchService);
  context.subscriptions.push(statusBar);

  // 4. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityToolkit.refreshAll', () => {
      accountTreeProvider.refresh();
      historyTreeProvider.refresh();
      quotaService.notifyQuotasUpdated();
      vscode.window.showInformationMessage('Antigravity Toolkit telemetry refreshed.');
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

  // 5. Setup Background Polling Timer for Quotas
  const config = vscode.workspace.getConfiguration('antigravityToolkit');
  const intervalSeconds = config.get<number>('quotaRefreshIntervalSeconds', 60);
  if (intervalSeconds > 0) {
    quotaIntervalTimer = setInterval(() => {
      quotaService.notifyQuotasUpdated();
    }, intervalSeconds * 1000);
  }

  // 6. Proactive Heartbeat & Background Sync to Shield
  const shieldBridge = ShieldBridge.getInstance();
  const sendHb = () => {
    const active = accountService.getActiveAccount();
    shieldBridge.sendHeartbeat(active?.email).catch(() => {});
  };

  sendHb();
  heartbeatTimer = setInterval(sendHb, 20000);

  setTimeout(() => {
    accountService.syncFromShield().catch(() => {});
  }, 2000);

  console.log('[Antigravity Toolkit 2.0] Activated successfully.');
}

export function deactivate() {
  if (quotaIntervalTimer) {
    clearInterval(quotaIntervalTimer);
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
}
