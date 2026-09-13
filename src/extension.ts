import * as vscode from 'vscode';
import { AccountService } from './services/accountService';
import { QuotaService } from './services/quotaService';
import { ConversationService } from './services/conversationService';
import { AccountTreeProvider } from './providers/accountTreeProvider';
import { HistoryTreeProvider } from './providers/historyTreeProvider';
import { QuotaWebviewProvider } from './providers/quotaWebviewProvider';
import { StatusBarManager } from './ui/statusBar';
import { ConversationSession } from './types';

let quotaIntervalTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('[Antigravity Toolkit] Activating extension...');

  // 1. Initialize core services
  const accountService = AccountService.initialize(context);
  const quotaService = QuotaService.getInstance();
  const conversationService = ConversationService.getInstance();

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
    accountService
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      QuotaWebviewProvider.viewType,
      quotaWebviewProvider
    )
  );

  // 3. Status Bar
  const statusBar = new StatusBarManager(accountService, quotaService);
  context.subscriptions.push(statusBar);

  // 4. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityToolkit.refreshAll', () => {
      accountTreeProvider.refresh();
      historyTreeProvider.refresh();
      quotaService.notifyQuotasUpdated();
      vscode.window.showInformationMessage('Antigravity Toolkit refreshed.');
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

        const items = accounts.map((acc) => ({
          label: acc.email,
          description: acc.isActive ? '$(check) Active' : acc.tier || 'Ready',
          detail: `ID: ${acc.id} | Tier: ${acc.tier || 'Free'}`,
          account: acc,
        }));

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

  // 6. Proactive Background Probe to Shield
  setTimeout(() => {
    accountService.syncFromShield().catch(() => {});
  }, 2000);

  console.log('[Antigravity Toolkit] Activated successfully.');
}

export function deactivate() {
  if (quotaIntervalTimer) {
    clearInterval(quotaIntervalTimer);
  }
}
