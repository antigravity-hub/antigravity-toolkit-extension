import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import { Account } from '../types';
import { LanguageServerClient } from '../bridge/languageServerClient';
import { ShieldBridge } from '../bridge/shieldBridge';

// ─── Protobuf Serialization Helpers for UnifiedStateSync ───
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  if (value === 0) return Buffer.from([0]);
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeString(fieldNumber: number, value: string): Buffer {
  const buf = Buffer.from(value, 'utf-8');
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(buf.length), buf]);
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(value)]);
}

function encodeMessage(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(payload.length), payload]);
}

function buildUserStatusUpdate(name: string, email: string): string {
  const proto = Buffer.concat([
    encodeVarintField(2, 1),
    encodeString(3, name),
    encodeString(7, email),
  ]);
  const row = encodeString(1, proto.toString('base64'));
  const update = Buffer.concat([
    encodeString(1, 'userStatusSentinelKey'),
    encodeMessage(2, row),
  ]);
  return Buffer.concat([
    encodeString(1, 'uss-userStatus'),
    encodeMessage(5, update),
  ]).toString('base64');
}

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
   * 1. Updates local active state & persists
   * 2. Injects credentials into IDE in-memory UnifiedStateSync (USS)
   * 3. Triggers handleAuthRefresh & calls RegisterGdmUser on all active Language Server processes
   * 4. Syncs legacy state.vscdb and disk configs (~/.antigravity_shield & ~/.gemini)
   * 5. Notifies Shield daemon
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

    const targetName = target.name || target.email.split('@')[0];
    const accessToken = target.token?.accessToken || '';
    const refreshToken = target.token?.refreshToken || '';
    const expiryTimestamp = target.token?.expiryTimestamp
      ? Math.floor(target.token.expiryTimestamp > 10000000000 ? target.token.expiryTimestamp / 1000 : target.token.expiryTimestamp)
      : Math.floor(Date.now() / 1000) + 3600;

    // 1. In-memory USS Hot-Swap
    try {
      const uss = (vscode as any).antigravityUnifiedStateSync;
      if (uss) {
        // Push user status update (name and email)
        const updateB64 = buildUserStatusUpdate(targetName, target.email);
        await uss.pushSerializedUpdateIPC(updateB64);

        // Set OAuth token info in USS
        if (uss.OAuthPreferences?.setOAuthTokenInfo) {
          await uss.OAuthPreferences.setOAuthTokenInfo({
            accessToken,
            refreshToken,
            expiryDateSeconds: expiryTimestamp,
            tokenType: 'Bearer',
            isGcpTos: false,
          });
        }

        // Fire handleAuthRefresh to propagate new auth context
        try {
          await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
        } catch {
          // non-fatal
        }
      }
    } catch (ussErr) {
      console.warn('[AccountService] USS hot-swap non-fatal warning:', ussErr);
    }

    // 2. Language Server In-Memory RPC Hot-Swap (RegisterGdmUser)
    try {
      const lsClient = LanguageServerClient.getInstance();
      await lsClient.callRegisterGdmUser();
    } catch (lsErr) {
      console.warn('[AccountService] Language Server hot-swap warning:', lsErr);
    }

    // 3. Write legacy auth status to SQLite state.vscdb
    try {
      const proto = Buffer.concat([
        encodeVarintField(2, 1),
        encodeString(3, targetName),
        encodeString(7, target.email),
      ]);
      const json = JSON.stringify({ name: targetName, apiKey: accessToken, email: target.email, userStatusProtoBinaryBase64: proto.toString('base64') });
      const hexValue = Buffer.from(json, 'utf-8').toString('hex');
      const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : '');
      if (appData) {
        const dbPath = path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
        if (fs.existsSync(dbPath)) {
          const sql = `UPDATE ItemTable SET value = CAST(X'${hexValue}' AS TEXT) WHERE key = 'antigravityAuthStatus';`;
          child_process.exec(`sqlite3 "${dbPath}" "${sql}"`, () => {});
        }
      }
    } catch {
      // non-fatal
    }

    // 4. Notify local Shield daemon & sync credentials with real UUID and Auth
    const shield = ShieldBridge.getInstance();
    await shield.notifyShieldSwitch(email, target.id);

    vscode.window.showInformationMessage(`⚡ Switched to ${email}`);
    this.onDidChangeAccountsEmitter.fire();

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
