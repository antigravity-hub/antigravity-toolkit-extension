import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import { promisify } from 'util';
import { Account } from '../types';
import { LanguageServerClient } from '../bridge/languageServerClient';
import { ShieldBridge } from '../bridge/shieldBridge';
import {
  parseProtoFields,
  updateUserStatusProto,
  wrapUserStatusInUSS,
  wrapUserStatusForVscdb,
  getFallbackUserStatusProto,
  encodeVarintField,
  encodeString,
} from '../utils/protobufHelper';

const execAsync = promisify(child_process.exec);

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

    // 1. In-memory USS Hot-Swap with Full Model Preservation
    let updatedProto: Buffer | null = null;
    try {
      const uss = (vscode as any).antigravityUnifiedStateSync;
      if (uss) {
        // Resolve full UserStatus preserving all 14 cascade models
        updatedProto = await this.getFullUserStatusProto(targetName, target.email);
        const updateB64 = wrapUserStatusInUSS(updatedProto);
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

    // 3. Write preserved auth status to SQLite state.vscdb
    try {
      const protoToSave = updatedProto || (await this.getFullUserStatusProto(targetName, target.email));
      const json = JSON.stringify({
        name: targetName,
        apiKey: accessToken,
        email: target.email,
        userStatusProtoBinaryBase64: protoToSave.toString('base64'),
      });
      const hexAuth = Buffer.from(json, 'utf-8').toString('hex');
      const vscdbUss = wrapUserStatusForVscdb(protoToSave);
      const hexUss = Buffer.from(vscdbUss, 'utf-8').toString('hex');

      const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : '');
      if (appData) {
        const dbPath = path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
        if (fs.existsSync(dbPath)) {
          const sql = `UPDATE ItemTable SET value = CAST(X'${hexAuth}' AS TEXT) WHERE key = 'antigravityAuthStatus'; UPDATE ItemTable SET value = CAST(X'${hexUss}' AS TEXT) WHERE key = 'antigravityUnifiedStateSync.userStatus';`;
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
   * Resolves the complete UserStatus protobuf containing all 14 cascade models.
   * Priority:
   * 1. In-memory USS live state (uss.UserStatus.getUserStatus())
   * 2. Persistent globalState cache
   * 3. SQLite state.vscdb (antigravityUnifiedStateSync.userStatus)
   * 4. Bundled fallback template containing all 14 models
   */
  private async getFullUserStatusProto(targetName: string, targetEmail: string): Promise<Buffer> {
    let baseProto: Buffer | null = null;

    // 1. Try in-memory USS UserStatus (live)
    try {
      const uss = (vscode as any).antigravityUnifiedStateSync;
      if (uss?.UserStatus?.getUserStatus) {
        const rawB64 = await uss.UserStatus.getUserStatus();
        if (typeof rawB64 === 'string' && rawB64.length > 500) {
          const candidate = Buffer.from(rawB64, 'base64');
          if (candidate.length > 500) {
            baseProto = candidate;
          }
        }
      }
    } catch {}

    // 2. Try persistent cache from globalState
    if (!baseProto) {
      const cachedB64 = this.context.globalState.get<string>('antigravity_user_status_proto_cache');
      if (cachedB64 && cachedB64.length > 500) {
        try {
          const candidate = Buffer.from(cachedB64, 'base64');
          if (candidate.length > 500) {
            baseProto = candidate;
          }
        } catch {}
      }
    }

    // 3. Try reading SQLite state.vscdb directly
    if (!baseProto) {
      try {
        const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : '');
        if (appData) {
          const dbPath = path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
          if (fs.existsSync(dbPath)) {
            const cmd = `python -c "import sqlite3, base64; cur=sqlite3.connect(r'${dbPath}').cursor(); cur.execute('SELECT value FROM ItemTable WHERE key=\\'antigravityUnifiedStateSync.userStatus\\''); r=cur.fetchone(); print(r[0] if r else '')"`;
            const { stdout } = await execAsync(cmd, { timeout: 3000 }).catch(() => ({ stdout: '' }));
            if (stdout && stdout.trim().length > 500) {
              const raw = Buffer.from(stdout.trim(), 'base64');
              const top = parseProtoFields(raw);
              if (top.length > 0 && top[0].wt === 2) {
                const wrapper = parseProtoFields(top[0].data);
                const row = parseProtoFields(wrapper[1]?.data || Buffer.alloc(0));
                if (row.length > 0 && row[0].wt === 2) {
                  baseProto = Buffer.from(row[0].data.toString('utf-8'), 'base64');
                }
              }
            }
          }
        }
      } catch {}
    }

    // 4. Try bundled fallback template with all 14 models
    if (!baseProto || baseProto.length < 500) {
      const fallback = getFallbackUserStatusProto();
      if (fallback && fallback.length > 500) {
        baseProto = fallback;
      }
    }

    // If still null (extreme edge case), construct baseline
    if (!baseProto || baseProto.length < 50) {
      baseProto = Buffer.concat([
        encodeVarintField(2, 1),
        encodeString(3, targetName),
        encodeString(7, targetEmail),
      ]);
    }

    // Update with new account name and email while preserving Field 33 (14 models)
    const updated = updateUserStatusProto(baseProto, targetName, targetEmail);

    // Save to globalState cache
    await this.context.globalState.update('antigravity_user_status_proto_cache', updated.toString('base64'));

    return updated;
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
