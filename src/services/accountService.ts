import * as vscode from 'vscode';
import { Account } from '../types';
import { LanguageServerClient } from '../bridge/languageServerClient';
import { ShieldBridge } from '../bridge/shieldBridge';

const STORAGE_KEY_ACCOUNTS = 'antigravity_toolkit_accounts';
const STORAGE_KEY_ACTIVE = 'antigravity_toolkit_active_email';

export class AccountService {
  private static instance: AccountService;
  private context: vscode.ExtensionContext;
  private accounts: Map<string, Account> = new Map();
  private activeEmail: string | null = null;

  private onDidChangeAccountsEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeAccounts = this.onDidChangeAccountsEmitter.event;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.loadPersistedAccounts();
  }

  public static initialize(context: vscode.ExtensionContext): AccountService {
    if (!AccountService.instance) {
      AccountService.instance = new AccountService(context);
    }
    return AccountService.instance;
  }

  public static getInstance(): AccountService {
    return AccountService.instance;
  }

  private loadPersistedAccounts(): void {
    const raw = this.context.globalState.get<Account[]>(STORAGE_KEY_ACCOUNTS, []);
    this.activeEmail = this.context.globalState.get<string | null>(STORAGE_KEY_ACTIVE, null);

    this.accounts.clear();
    for (const acc of raw) {
      this.accounts.set(acc.email, acc);
    }

    // If storage was empty, immediately hydrate from local Shield disk storage
    if (this.accounts.size === 0) {
      const local = ShieldBridge.getInstance().loadAccountsFromLocalDisk();
      for (const acc of local) {
        this.accounts.set(acc.email, acc);
      }
      if (!this.activeEmail && local.length > 0) {
        const active = local.find((a) => a.isActive) || local[0];
        this.activeEmail = active.email;
      }
    }

    if (!this.activeEmail && this.accounts.size > 0) {
      const list = Array.from(this.accounts.values());
      const active = list.find((a) => a.isActive) || list[0];
      this.activeEmail = active.email;
    }
  }

  private async persistAccounts(): Promise<void> {
    const list = Array.from(this.accounts.values());
    await this.context.globalState.update(STORAGE_KEY_ACCOUNTS, list);
    await this.context.globalState.update(STORAGE_KEY_ACTIVE, this.activeEmail);
    this.onDidChangeAccountsEmitter.fire();
  }

  public getAccounts(): Account[] {
    return Array.from(this.accounts.values());
  }

  public getActiveAccount(): Account | undefined {
    if (!this.activeEmail) return undefined;
    return this.accounts.get(this.activeEmail);
  }

  public async addOrUpdateAccount(account: Account): Promise<void> {
    this.accounts.set(account.email, account);
    if (!this.activeEmail || account.isActive) {
      this.activeEmail = account.email;
    }
    await this.persistAccounts();
  }

  public async removeAccount(email: string): Promise<void> {
    this.accounts.delete(email);
    if (this.activeEmail === email) {
      const remaining = this.getAccounts();
      this.activeEmail = remaining.length > 0 ? remaining[0].email : null;
    }
    await this.persistAccounts();
  }

  /**
   * Performs an instant live account switch:
   * 1. Updates local active state
   * 2. Hot-swaps credentials in Language Server memory (zero window restarts)
   * 3. Sends sync notice to Antigravity Shield
   */
  public async switchAccount(email: string): Promise<boolean> {
    const target = this.accounts.get(email);
    if (!target) {
      vscode.window.showErrorMessage(`Account ${email} not found.`);
      return false;
    }

    // Update active flags
    this.activeEmail = email;
    for (const [key, acc] of this.accounts.entries()) {
      acc.isActive = key === email;
    }
    await this.persistAccounts();

    // Hot-swap in Language Server memory
    const lsClient = LanguageServerClient.getInstance();
    const lsSuccess = await lsClient.registerUserInMemory(target);

    // Notify local Shield daemon & sync files
    const shield = ShieldBridge.getInstance();
    await shield.notifyShieldSwitch(email);

    if (lsSuccess) {
      vscode.window.showInformationMessage(`Active account switched to: ${email}`);
    } else {
      vscode.window.showInformationMessage(`Active account set to: ${email}`);
    }

    return true;
  }

  /**
   * Pulls fresh accounts from Antigravity Shield (HTTP or local disk)
   */
  public async syncFromShield(): Promise<number> {
    const shield = ShieldBridge.getInstance();
    let fetched = await shield.fetchShieldAccounts();
    if (fetched.length === 0) {
      fetched = shield.loadAccountsFromLocalDisk();
    }

    if (fetched.length === 0) {
      vscode.window.showInformationMessage('No accounts found in Shield or local storage.');
      return 0;
    }

    this.accounts.clear();
    for (const acc of fetched) {
      this.accounts.set(acc.email, acc);
      if (acc.isActive) {
        this.activeEmail = acc.email;
      }
    }

    if (!this.activeEmail && fetched.length > 0) {
      this.activeEmail = fetched[0].email;
      fetched[0].isActive = true;
    }

    await this.persistAccounts();
    vscode.window.showInformationMessage(`Successfully synchronized ${fetched.length} accounts from Shield.`);
    return fetched.length;
  }
}
