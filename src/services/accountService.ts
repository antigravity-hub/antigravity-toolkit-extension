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

    // Always re-hydrate from Shield disk storage to guarantee real-time quota accuracy!
    const local = ShieldBridge.getInstance().loadAccountsFromLocalDisk();
    if (local.length > 0) {
      for (const acc of local) {
        this.accounts.set(acc.email, acc);
        if (acc.isActive) {
          this.activeEmail = acc.email;
        }
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

    // Hot-swap attempt in Language Server memory
    const lsClient = LanguageServerClient.getInstance();
    await lsClient.registerUserInMemory(target);

    // Notify local Shield daemon & sync credentials with real UUID and Auth
    const shield = ShieldBridge.getInstance();
    const switchResult = await shield.notifyShieldSwitch(email, target.id);

    if (switchResult.handledByShield) {
      vscode.window.showInformationMessage(
        `⚡ Switching to ${email}... Antigravity Shield is reloading the IDE session.`
      );
    } else {
      const choice = await vscode.window.showInformationMessage(
        `Active account credentials set to ${email}. Reload window to apply now?`,
        'Reload Window',
        'Later'
      );
      if (choice === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }

    return true;
  }

  /**
   * Calculates an accurate health score (0-100) based on Gemini quota groups and models,
   * matching Antigravity Shield desktop telemetry.
   */
  public getAccountHealth(account: Account): number {
    // 1. Primary: check Gemini quota group (matching Shield desktop)
    if (account.quotaGroups && account.quotaGroups.length > 0) {
      const geminiGroup = account.quotaGroups.find((g) =>
        g.displayName.toLowerCase().includes('gemini')
      );
      if (geminiGroup) {
        if (geminiGroup.fiveHourBucket && typeof geminiGroup.fiveHourBucket.remainingPercentage === 'number') {
          return geminiGroup.fiveHourBucket.remainingPercentage;
        }
        if (geminiGroup.weeklyBucket && typeof geminiGroup.weeklyBucket.remainingPercentage === 'number') {
          return geminiGroup.weeklyBucket.remainingPercentage;
        }
      }
    }

    // 2. Secondary: check core Gemini models (e.g. Pro, High, Flash)
    if (account.quotas && account.quotas.length > 0) {
      const geminiModels = account.quotas.filter((q) =>
        q.modelId.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('gemini')
      );
      if (geminiModels.length > 0) {
        const primary = geminiModels.find((q) =>
          q.modelId.toLowerCase().includes('pro') || q.displayName.toLowerCase().includes('pro')
        ) || geminiModels[0];

        return typeof primary.remainingQuota === 'number'
          ? primary.remainingQuota
          : Math.max(0, 100 - primary.usagePercentage);
      }

      const totalRemaining = account.quotas.reduce((sum, q) => {
        const remaining = typeof q.remainingQuota === 'number'
          ? q.remainingQuota
          : Math.max(0, 100 - q.usagePercentage);
        return sum + remaining;
      }, 0);

      return Math.round(totalRemaining / account.quotas.length);
    }

    return 100;
  }

  /**
   * Evaluates all standby accounts and picks the best one for auto-rotation.
   */
  public getBestNextAccount(excludeEmail?: string): { account: Account; healthScore: number } | null {
    const list = this.getAccounts().filter((a) => {
      if (excludeEmail && a.email.toLowerCase() === excludeEmail.toLowerCase()) {
        return false;
      }
      return true;
    });

    if (list.length === 0) {
      return null;
    }

    const scored = list.map((account) => ({
      account,
      healthScore: this.getAccountHealth(account),
    }));

    // Sort descending by health score
    scored.sort((a, b) => b.healthScore - a.healthScore);

    // Pick top candidate if healthy (> 5% quota available)
    if (scored.length > 0 && scored[0].healthScore > 5) {
      return scored[0];
    }

    return null;
  }

  /**
   * Pulls fresh accounts from Antigravity Shield (local disk storage & daemon)
   */
  public async syncFromShield(): Promise<number> {
    const shield = ShieldBridge.getInstance();
    let fetched = shield.loadAccountsFromLocalDisk();
    if (fetched.length === 0) {
      fetched = await shield.fetchShieldAccounts();
    }

    if (fetched.length === 0) {
      vscode.window.showInformationMessage('No accounts found in Shield storage.');
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
    vscode.window.showInformationMessage(`Successfully synchronized ${fetched.length} accounts from Antigravity Shield.`);
    return fetched.length;
  }
}
