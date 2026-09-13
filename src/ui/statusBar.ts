import * as vscode from 'vscode';
import { AccountService } from '../services/accountService';
import { QuotaService } from '../services/quotaService';

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor(
    private accountService: AccountService,
    private quotaService: QuotaService
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'antigravityToolkit.switchAccount';

    this.accountService.onDidChangeAccounts(() => this.update());
    this.quotaService.onDidChangeQuotas(() => this.update());

    this.update();
  }

  public update(): void {
    const config = vscode.workspace.getConfiguration('antigravityToolkit');
    const enabled = config.get<boolean>('showStatusBarBadge', true);
    if (!enabled) {
      this.statusBarItem.hide();
      return;
    }

    const active = this.accountService.getActiveAccount();
    if (!active) {
      this.statusBarItem.text = '$(rocket) Antigravity: No Account';
      this.statusBarItem.tooltip = 'Click to configure Antigravity account';
      this.statusBarItem.show();
      return;
    }

    this.statusBarItem.text = `$(rocket) ${active.email.split('@')[0]}`;
    this.statusBarItem.tooltip = `Active: ${active.email}\nPlan: ${active.tier || 'Free'}\nClick to switch account`;
    this.statusBarItem.show();
  }

  public dispose(): void {
    this.statusBarItem.dispose();
  }
}
