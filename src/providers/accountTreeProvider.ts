import * as vscode from 'vscode';
import { AccountService } from '../services/accountService';
import { Account } from '../types';

export class AccountTreeItem extends vscode.TreeItem {
  constructor(public readonly account: Account) {
    super(account.email, vscode.TreeItemCollapsibleState.None);

    this.description = account.isActive ? '● Active' : account.tier || 'Ready';
    this.tooltip = `Account: ${account.email}\nStatus: ${account.isActive ? 'Active' : 'Inactive'}\nTier: ${account.tier || 'Free'}`;
    this.contextValue = 'accountItem';

    if (account.isActive) {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
    } else {
      this.iconPath = new vscode.ThemeIcon('account');
    }

    this.command = {
      command: 'antigravityToolkit.switchAccount',
      title: 'Switch Account',
      arguments: [account.email],
    };
  }
}

export class AccountTreeProvider implements vscode.TreeDataProvider<AccountTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<AccountTreeItem | undefined | null | void> =
    new vscode.EventEmitter<AccountTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<AccountTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(private accountService: AccountService) {
    this.accountService.onDidChangeAccounts(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AccountTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AccountTreeItem): Thenable<AccountTreeItem[]> {
    if (element) {
      return Promise.resolve([]);
    }

    const accounts = this.accountService.getAccounts();
    if (accounts.length === 0) {
      return Promise.resolve([]);
    }

    return Promise.resolve(accounts.map((acc) => new AccountTreeItem(acc)));
  }
}
