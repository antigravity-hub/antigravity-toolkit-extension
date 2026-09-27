import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Account, ModelQuota, TokenUsageStats } from '../types';

export class ShieldBridge {
  private static instance: ShieldBridge;
  private detectedBaseUrl: string | null = null;

  public static getInstance(): ShieldBridge {
    if (!ShieldBridge.instance) {
      ShieldBridge.instance = new ShieldBridge();
    }
    return ShieldBridge.instance;
  }

  private pingUrl(url: URL, timeoutMs = 400): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  public resetDetectedBaseUrl(): void {
    this.detectedBaseUrl = null;
  }

  public static safeQuotaPercentage(fraction?: number | null): number {
    if (fraction === undefined || fraction === null || isNaN(fraction)) return 0;
    if (fraction >= 1.0) return 100;
    if (fraction <= 0.0) return 0;
    const raw = fraction * 100;
    if (raw > 99) return 99;
    return Math.round(raw);
  }

  public static formatPaddedCountdown(durationMs: number, isWeekly = false): string {
    const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalSeconds / 3600);
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

    if (isWeekly && totalHours >= 24) {
      const days = Math.floor(totalHours / 24);
      const remHours = totalHours % 24;
      return `${days}d ${remHours}h`;
    }

    if (totalHours > 0) {
      const minutes = totalMinutes % 60;
      return `${pad(totalHours)}h ${pad(minutes)}m`;
    }

    return `${pad(totalMinutes)}m`;
  }

  public async getBaseUrl(): Promise<string> {
    if (this.detectedBaseUrl) {
      const alive = await this.pingUrl(new URL('/api/health', this.detectedBaseUrl), 300);
      if (alive) return this.detectedBaseUrl;
      this.detectedBaseUrl = null;
    }
    const config = vscode.workspace.getConfiguration('antigravityToolkit');
    const configured = config.get<string>('shieldApiUrl');
    if (configured && configured !== 'http://127.0.0.1:8765' && configured !== 'http://127.0.0.1:8045') {
      return configured;
    }

    // 1. First, check ~/.antigravity_shield/bridge_info.json for active dynamic port
    try {
      const home = os.homedir();
      const infoPath = path.join(home, '.antigravity_shield', 'bridge_info.json');
      if (fs.existsSync(infoPath)) {
        const raw = fs.readFileSync(infoPath, 'utf8');
        const info = JSON.parse(raw);
        if (info && info.port) {
          const candidate = `http://127.0.0.1:${info.port}`;
          const ok = await this.pingUrl(new URL('/api/health', candidate), 300);
          if (ok) {
            this.detectedBaseUrl = candidate;
            return candidate;
          }
        }
        if (info && info.companion_port) {
          const candidate = `http://127.0.0.1:${info.companion_port}`;
          const ok = await this.pingUrl(new URL('/api/health', candidate), 300);
          if (ok) {
            this.detectedBaseUrl = candidate;
            return candidate;
          }
        }
      }
    } catch {
      // ignore and proceed to candidate list
    }

    // 2. Auto-detect between candidate ports in parallel
    const candidates = [
      'http://127.0.0.1:8765',
      'http://127.0.0.1:8046',
      'http://127.0.0.1:8766',
      'http://127.0.0.1:8045',
      'http://127.0.0.1:8047',
    ];
    try {
      const checks = candidates.map(async (candidate) => {
        try {
          const ok = await this.pingUrl(new URL('/api/health', candidate), 250);
          if (ok) return candidate;
        } catch {}
        return null;
      });
      const results = await Promise.all(checks);
      const aliveCandidate = results.find((c): c is string => Boolean(c));
      if (aliveCandidate) {
        this.detectedBaseUrl = aliveCandidate;
        return aliveCandidate;
      }
    } catch {}
    return 'http://127.0.0.1:8765';
  }

  public isLastKnownOnline(): boolean {
    return Boolean(this.detectedBaseUrl);
  }

  /**
   * Health check to detect if Antigravity Shield desktop or daemon is active.
   */
  public async isShieldOnline(): Promise<boolean> {
    try {
      const baseUrl = await this.getBaseUrl();
      const url = new URL('/api/health', baseUrl);
      const isOnline = await this.pingUrl(url, 300);
      if (isOnline) return true;
    } catch {
      // ignore
    }

    // Check candidate ports in parallel for fast discovery
    const ports = [8046, 8766, 8045, 8765];
    const checks = ports.map(async (port) => {
      try {
        const isOnline = await this.pingUrl(new URL(`http://127.0.0.1:${port}/api/health`), 250);
        if (isOnline) {
          this.detectedBaseUrl = `http://127.0.0.1:${port}`;
          return true;
        }
      } catch {}
      try {
        const isOnline = await this.pingUrl(new URL(`http://127.0.0.1:${port}/toolkit/status`), 250);
        if (isOnline) {
          this.detectedBaseUrl = `http://127.0.0.1:${port}`;
          return true;
        }
      } catch {}
      return false;
    });

    const results = await Promise.all(checks);
    if (results.some(Boolean)) return true;

    this.detectedBaseUrl = null;
    return false;
  }

  private fetchFromUrl(url: URL): Promise<Account[]> {
    return new Promise((resolve) => {
      try {
        const apiKey = this.getShieldApiKey();
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const req = http.get(url, { headers, timeout: 3000 }, (res) => {
          if (res.statusCode !== 200) {
            resolve([]);
            return;
          }
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const rawList = Array.isArray(json) ? json : json.accounts || [];
              const accounts: Account[] = rawList.map((acc: any) => ({
                id: acc.id || acc.email,
                email: acc.email,
                name: acc.name || acc.email.split('@')[0],
                avatarUrl: acc.avatarUrl || acc.picture,
                isActive: !!acc.isActive || !!acc.is_active || !!acc.is_current,
                tier: acc.tier || (acc.quota && acc.quota.subscription_tier) || 'Google AI Pro',
                token: {
                  accessToken: acc.token?.access_token || acc.accessToken || '',
                  refreshToken: acc.token?.refresh_token || acc.refreshToken || '',
                  expiryTimestamp: acc.token?.expiry_timestamp || acc.expiryTimestamp || 0,
                  projectId: acc.token?.project_id || acc.projectId,
                  idToken: acc.token?.id_token || acc.idToken,
                },
                lastSyncedAt: Date.now(),
                disabled: Boolean(acc.disabled),
                disabledReason: acc.disabled_reason || acc.disabledReason,
                proxyDisabled: Boolean(acc.proxy_disabled || acc.proxyDisabled),
                proxyDisabledReason: acc.proxy_disabled_reason || acc.proxyDisabledReason,
                validationBlocked: Boolean(acc.validation_blocked || acc.validationBlocked),
                validationBlockedReason: acc.validation_blocked_reason || acc.validationBlockedReason,
                isForbidden: Boolean(acc.quota?.is_forbidden || acc.is_forbidden || acc.isForbidden),
                forbiddenReason: acc.quota?.forbidden_reason || acc.forbidden_reason || acc.forbiddenReason,
              }));
              resolve(accounts);
            } catch {
              resolve([]);
            }
          });
        });

        req.on('error', () => resolve([]));
        req.on('timeout', () => {
          req.destroy();
          resolve([]);
        });
      } catch {
        resolve([]);
      }
    });
  }

  /**
   * Reads accounts directly from local Antigravity Shield storage with zero network dependency.
   */
  public loadAccountsFromLocalDisk(): Account[] {
    try {
      const home = os.homedir();
      const shieldDir = path.join(home, '.antigravity_shield');
      const accountsJsonPath = path.join(shieldDir, 'accounts.json');
      if (!fs.existsSync(accountsJsonPath)) {
        return [];
      }

      const indexContent = fs.readFileSync(accountsJsonPath, 'utf8');
      const index = JSON.parse(indexContent);
      if (!index || !Array.isArray(index.accounts)) {
        return [];
      }

      let activeEmailFromGemini: string | null = null;
      try {
        const geminiAccPath = path.join(home, '.gemini', 'google_accounts.json');
        if (fs.existsSync(geminiAccPath)) {
          const gData = JSON.parse(fs.readFileSync(geminiAccPath, 'utf8'));
          if (gData && gData.active) activeEmailFromGemini = gData.active;
        }
      } catch {
        // ignore
      }

      const activeAccountId = index.active_ide_account_id || index.current_account_id;
      const result: Account[] = [];

      for (const acc of index.accounts) {
        let token = {
          accessToken: '',
          refreshToken: '',
          expiryTimestamp: 0,
          projectId: undefined as string | undefined,
          idToken: undefined as string | undefined,
        };
        let tier = 'Google AI Pro';
        let avatarUrl: string | undefined = undefined;
        let quotas: ModelQuota[] = [];
        let quotaGroups: import('../types').QuotaGroup[] = [];

        let disabled = Boolean(acc.disabled);
        let disabledReason: string | undefined = acc.disabled_reason;
        let proxyDisabled = Boolean(acc.proxy_disabled);
        let proxyDisabledReason: string | undefined = acc.proxy_disabled_reason;
        let validationBlocked = Boolean(acc.validation_blocked);
        let validationBlockedReason: string | undefined = acc.validation_blocked_reason;
        let isForbidden = false;
        let forbiddenReason: string | undefined = undefined;

        const detailPath = path.join(shieldDir, 'accounts', `${acc.id}.json`);
        if (fs.existsSync(detailPath)) {
          try {
            const detail = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
            if (detail.disabled !== undefined) disabled = Boolean(detail.disabled);
            if (detail.disabled_reason) disabledReason = detail.disabled_reason;
            if (detail.proxy_disabled !== undefined) proxyDisabled = Boolean(detail.proxy_disabled);
            if (detail.proxy_disabled_reason) proxyDisabledReason = detail.proxy_disabled_reason;
            if (detail.validation_blocked !== undefined) validationBlocked = Boolean(detail.validation_blocked);
            if (detail.validation_blocked_reason) validationBlockedReason = detail.validation_blocked_reason;
            if (detail.quota?.is_forbidden) {
              isForbidden = true;
              forbiddenReason = detail.quota.forbidden_reason;
            } else if (detail.is_forbidden) {
              isForbidden = true;
              forbiddenReason = detail.forbidden_reason;
            }

            if (detail.token) {
              const exp = detail.token.expiry_timestamp || detail.token.expiryTimestamp || 0;
              token = {
                accessToken: detail.token.access_token || detail.token.accessToken || '',
                refreshToken: detail.token.refresh_token || detail.token.refreshToken || '',
                expiryTimestamp: exp > 0 && exp < 10000000000 ? exp * 1000 : exp,
                projectId: detail.token.project_id || detail.token.projectId,
                idToken: detail.token.id_token || detail.token.idToken,
              };
            }
            if (detail.quota) {
              tier = detail.quota.subscription_tier || tier;
              if (Array.isArray(detail.quota.quota_groups)) {
                quotaGroups = detail.quota.quota_groups.map((g: any) => {
                  let fiveHourBucket: import('../types').QuotaBucket | undefined;
                  let weeklyBucket: import('../types').QuotaBucket | undefined;

                  if (Array.isArray(g.buckets)) {
                    for (const b of g.buckets) {
                      const isWeekly = b.window === 'weekly';
                      const remaining = typeof b.remaining_fraction === 'number'
                        ? ShieldBridge.safeQuotaPercentage(b.remaining_fraction)
                        : typeof b.percentage === 'number'
                        ? (b.percentage > 99 && b.percentage < 100 ? 99 : b.percentage)
                        : 100;
                      const resetMs = b.reset_time ? new Date(b.reset_time).getTime() : 0;
                      const durationMs = resetMs > Date.now() ? Math.max(0, resetMs - Date.now()) : 0;
                      const resetFormatted =
                        remaining >= 100 && !isWeekly
                          ? 'Ready'
                          : durationMs > 0
                          ? ShieldBridge.formatPaddedCountdown(durationMs, isWeekly)
                          : remaining >= 100
                          ? 'Ready'
                          : '00m';

                      const bucket: import('../types').QuotaBucket = {
                        bucketId: b.bucket_id || b.window,
                        window: isWeekly ? 'weekly' : '5h',
                        remainingPercentage: remaining,
                        resetTimeMs: resetMs,
                        resetTimeFormatted: resetFormatted,
                        displayName: b.display_name || (isWeekly ? 'Weekly Limit' : '5-Hour Limit'),
                      };

                      if (isWeekly) {
                        weeklyBucket = bucket;
                      } else {
                        fiveHourBucket = bucket;
                      }
                    }
                  }

                  return {
                    displayName: g.display_name,
                    description: g.description,
                    fiveHourBucket,
                    weeklyBucket,
                  };
                });
              }

              if (Array.isArray(detail.quota.models)) {
                quotas = detail.quota.models.map((m: any) => {
                  const remaining = typeof m.percentage === 'number' ? m.percentage : 100;
                  const usage = Math.max(0, 100 - remaining);
                  const resetMs = m.reset_time ? new Date(m.reset_time).getTime() : Date.now() + 5 * 3600 * 1000;
                  const durationMs = Math.max(0, resetMs - Date.now());
                  const resetFormatted = ShieldBridge.formatPaddedCountdown(durationMs, false);

                  return {
                    modelId: m.name || m.display_name,
                    displayName: m.display_name || m.name,
                    usagePercentage: usage,
                    remainingQuota: remaining,
                    totalQuota: 100,
                    resetTimeMs: resetMs,
                    resetTimeFormatted: resetFormatted,
                    windowType: 'rolling_5h',
                  };
                });
              }
            }
            if (detail.picture) avatarUrl = detail.picture;
          } catch {
            // ignore
          }
        }

        // Prioritize active IDE account from Shield
        const isActive = Boolean(activeAccountId && acc.id === activeAccountId);

        result.push({
          id: acc.id,
          email: acc.email,
          name: acc.name || acc.email.split('@')[0],
          avatarUrl,
          isActive,
          tier,
          token,
          quotas,
          quotaGroups: quotaGroups.length > 0 ? quotaGroups : undefined,
          lastSyncedAt: Date.now(),
          disabled,
          disabledReason,
          proxyDisabled,
          proxyDisabledReason,
          validationBlocked,
          validationBlockedReason,
          isForbidden,
          forbiddenReason,
        });
      }

      return result;
    } catch {
      return [];
    }
  }

  /**
   * Fetches the complete accounts list and active status from Antigravity Shield.
   * Seamlessly falls back to local disk storage if network API is not yet reachable.
   */
  public async fetchShieldAccounts(): Promise<Account[]> {
    const baseUrl = await this.getBaseUrl();
    const endpoints = ['/api/toolkit/accounts', '/toolkit/accounts', '/api/accounts'];
    for (const ep of endpoints) {
      try {
        const accounts = await this.fetchFromUrl(new URL(ep, baseUrl));
        if (accounts.length > 0) {
          return accounts;
        }
      } catch {
        // try next
      }
    }

    // Direct local filesystem bridge fallback
    return this.loadAccountsFromLocalDisk();
  }

  /**
   * Resolves the account UUID by email from Shield's local accounts.json.
   */
  public resolveAccountIdByEmail(email: string): string | undefined {
    try {
      const home = os.homedir();
      const accountsJsonPath = path.join(home, '.antigravity_shield', 'accounts.json');
      if (fs.existsSync(accountsJsonPath)) {
        const index = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
        const found = index.accounts?.find(
          (a: any) => a.email.toLowerCase() === email.toLowerCase()
        );
        if (found) return found.id;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  /**
   * Notifies Shield that an account switch was triggered from the IDE,
   * passes the authentic account UUID with Bearer token authentication,
   * and synchronizes local configuration files (~/.antigravity_shield & ~/.gemini).
   */
  public async notifyShieldSwitch(
    email: string,
    accountId?: string
  ): Promise<{ success: boolean; handledByShield: boolean }> {
    const baseUrl = await this.getBaseUrl();
    const apiKey = this.getShieldApiKey();
    const targetUuid = accountId || this.resolveAccountIdByEmail(email) || email;

    const payload = {
      accountId: targetUuid,
      account_id: targetUuid,
      email: email,
      target_ide: 'ide',
    };
    const body = JSON.stringify(payload);

    const endpoints = [
      '/api/toolkit/sync-active',
      '/toolkit/sync-active',
      '/api/accounts/switch',
      '/accounts/switch',
      '/api/toolkit/switch',
      '/toolkit/switch',
      '/api/switch',
    ];

    let handledByShield = false;

    // Always update local disk configuration FIRST for instant synchronization
    this.syncDiskCredentials(email, targetUuid);

    for (const ep of endpoints) {
      try {
        const statusCode = await new Promise<number>((resolve) => {
          const url = new URL(ep, baseUrl);
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body).toString(),
          };
          if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }

          const req = http.request(
            url,
            {
              method: 'POST',
              headers,
              timeout: 3000,
            },
            (res) => resolve(res.statusCode || 0)
          );

          req.on('error', () => resolve(0));
          req.on('timeout', () => {
            req.destroy();
            resolve(0);
          });

          req.write(body);
          req.end();
        });

        if (statusCode >= 200 && statusCode < 300) {
          handledByShield = true;
          break;
        }
      } catch {
        // try next endpoint
      }
    }

    return { success: true, handledByShield };
  }

  /**
   * Directly updates local disk configurations (accounts.json, google_accounts.json, oauth_creds.json)
   * immediately before triggering Language Server RegisterGdmUser.
   */
  public syncDiskCredentials(email: string, targetUuid?: string): boolean {
    try {
      const home = os.homedir();
      const shieldDir = path.join(home, '.antigravity_shield');
      const accountsJsonPath = path.join(shieldDir, 'accounts.json');
      if (fs.existsSync(accountsJsonPath)) {
        const index = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
        const target = index.accounts.find(
          (a: any) => a.email.toLowerCase() === email.toLowerCase() || (targetUuid && a.id === targetUuid)
        );
        if (target) {
          index.active_ide_account_id = target.id;
          index.current_account_id = target.id;
          fs.writeFileSync(accountsJsonPath, JSON.stringify(index, null, 2), 'utf8');

          // Update ~/.gemini/google_accounts.json
          const geminiAccPath = path.join(home, '.gemini', 'google_accounts.json');
          const gData = { active: email, old: [] };
          fs.writeFileSync(geminiAccPath, JSON.stringify(gData, null, 2), 'utf8');

          // Update ~/.gemini/oauth_creds.json
          const detailPath = path.join(shieldDir, 'accounts', `${target.id}.json`);
          if (fs.existsSync(detailPath)) {
            const detail = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
            if (detail.token) {
              const credsPath = path.join(home, '.gemini', 'oauth_creds.json');
              const credsData = {
                access_token: detail.token.access_token || '',
                refresh_token: detail.token.refresh_token || '',
                expires_in: 3599,
                expiry_timestamp: detail.token.expiry_timestamp || 0,
                token_type: 'Bearer',
                email: target.email,
                project_id: detail.token.project_id || 'aicode-consumers',
                oauth_client_key: detail.token.oauth_client_key || 'antigravity_enterprise',
                is_gcp_tos: false,
                id_token: detail.token.id_token || '',
              };
              fs.writeFileSync(credsPath, JSON.stringify(credsData, null, 2), 'utf8');
            }
          }
          return true;
        }
      }
    } catch (err) {
      console.warn('[ShieldBridge] Error syncing disk credentials:', err);
    }
    return false;
  }

  /**
   * Reads API key from local Shield config (~/.antigravity_shield/gui_config.json)
   */
  public getShieldApiKey(): string | null {
    try {
      const home = os.homedir();
      const configPath = path.join(home, '.antigravity_shield', 'gui_config.json');
      if (fs.existsSync(configPath)) {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (data && data.proxy && data.proxy.api_key) {
          return data.proxy.api_key;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Proactively announces Toolkit availability to Shield via authenticated heartbeat.
   */
  public async sendHeartbeat(activeEmail?: string): Promise<boolean> {
    const payload = JSON.stringify({
      ide: 'Antigravity IDE',
      version: '2.0.0',
      active_email: activeEmail || null,
    });

    const apiKey = this.getShieldApiKey();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Read bridge_info.json if available for dynamic port discovery
    const dynamicPorts: number[] = [];
    try {
      const home = os.homedir();
      const infoPath = path.join(home, '.antigravity_shield', 'bridge_info.json');
      if (fs.existsSync(infoPath)) {
        const raw = fs.readFileSync(infoPath, 'utf8');
        const info = JSON.parse(raw);
        if (info?.port) dynamicPorts.push(info.port);
        if (info?.companion_port) dynamicPorts.push(info.companion_port);
      }
    } catch {
      // ignore
    }

    const targetPorts = Array.from(new Set([...dynamicPorts, 8765, 8045, 8046, 8047, 8766, 19527]));
    const targets: { port: number; path: string }[] = [];
    for (const p of targetPorts) {
      targets.push({ port: p, path: '/api/toolkit/heartbeat' });
      targets.push({ port: p, path: '/toolkit/heartbeat' });
    }

    for (const target of targets) {
      try {
        const url = new URL(`http://127.0.0.1:${target.port}${target.path}`);
        const ok = await new Promise<boolean>((resolve) => {
          const req = http.request(
            url,
            {
              method: 'POST',
              headers,
              timeout: 1500,
            },
            (res) => {
              let resData = '';
              res.on('data', (chunk) => (resData += chunk));
              res.on('end', () => {
                try {
                  const json = JSON.parse(resData);
                  if (json && json.command && this.commandHandler) {
                    Promise.resolve(this.commandHandler(json.command)).catch((err) => {
                      console.error('[ShieldBridge] Error in commandHandler from heartbeat:', err);
                    });
                  }
                } catch {
                  // ignore
                }
                resolve(res.statusCode === 200 || res.statusCode === 204);
              });
            }
          );
          req.on('error', () => resolve(false));
          req.on('timeout', () => {
            req.destroy();
            resolve(false);
          });
          req.write(payload);
          req.end();
        });
        if (ok) return true;
      } catch {
        // try next target
      }
    }
    return false;
  }

  private commandHandler: ((cmd: any) => Promise<void>) | null = null;
  private isPollingCommands = false;

  /**
   * Starts a real-time long-polling loop to receive instant switch commands from Shield.
   */
  public startCommandListener(onCommand: (cmd: any) => Promise<void>): void {
    this.commandHandler = onCommand;
    if (this.isPollingCommands) return;
    this.isPollingCommands = true;
    this.pollCommandsLoop();
  }

  /**
   * Gracefully terminates the long-polling loop and releases listener callback.
   */
  public stopCommandListener(): void {
    this.isPollingCommands = false;
    this.commandHandler = null;
  }

  private async pollCommandsLoop(): Promise<void> {
    while (this.isPollingCommands) {
      try {
        const baseUrl = await this.getBaseUrl();
        const apiKey = this.getShieldApiKey();
        const headers: Record<string, string> = {
          'Accept': 'application/json',
        };
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const pollPath = '/toolkit/commands/poll?timeout=15';
        const url = new URL(pollPath, baseUrl);
        const result = await new Promise<any>((resolve) => {
          const req = http.get(url, { headers, timeout: 25000 }, (res) => {
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(null);
              }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => {
            req.destroy();
            resolve(null);
          });
        });

        if (result && result.status === 'ok' && result.command && this.commandHandler) {
          console.log('[ShieldBridge] Received command from Shield via two-way tunnel:', result.command);
          try {
            await this.commandHandler(result.command);
          } catch (err) {
            console.error('[ShieldBridge] Error handling command from Shield:', err);
          }
        } else {
          // Prevent tight loop when server returns timeout, non-200, or empty poll
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch {
        // short delay on error
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /**
   * Helper to make authenticated HTTP GET calls to Shield API endpoints.
   */
  public async fetchShieldApi<T>(apiPath: string): Promise<T | null> {
    try {
      const baseUrl = await this.getBaseUrl();
      const url = new URL(apiPath, baseUrl);
      const apiKey = this.getShieldApiKey();
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['x-api-key'] = apiKey;
      }

      return new Promise<T | null>((resolve) => {
        const req = http.get(url, { headers, timeout: 2000 }, (res) => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
      });
    } catch {
      return null;
    }
  }

  /**
   * Helper to make authenticated HTTP POST calls to Shield API endpoints.
   */
  public async postShieldApi<T>(apiPath: string, bodyData: any): Promise<T | null> {
    try {
      const baseUrl = await this.getBaseUrl();
      const url = new URL(apiPath, baseUrl);
      const apiKey = this.getShieldApiKey();
      const payload = JSON.stringify(bodyData || {});
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload).toString(),
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['x-api-key'] = apiKey;
      }

      return new Promise<T | null>((resolve) => {
        const req = http.request(
          url,
          {
            method: 'POST',
            headers,
            timeout: 5000,
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(null);
              }
            });
          }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
        req.write(payload);
        req.end();
      });
    } catch {
      return null;
    }
  }

  /**
   * Triggers an immediate quota refresh for a specific account or all accounts in Shield.
   */
  public async refreshAccountQuota(accountIdOrEmail?: string): Promise<boolean> {
    try {
      if (accountIdOrEmail) {
        const encoded = encodeURIComponent(accountIdOrEmail);
        const res = await this.postShieldApi<any>(`/accounts/${encoded}/refresh`, {});
        if (res && res.success) return true;
        const res2 = await this.postShieldApi<any>(`/toolkit/accounts/${encoded}/refresh`, {});
        if (res2 && res2.success) return true;
      }
      const fallback = await this.postShieldApi<any>('/accounts/refresh', {});
      return Boolean(fallback && fallback.success);
    } catch {
      return false;
    }
  }

  /**
   * Triggers a batch refresh for all accounts in Shield.
   */
  public async refreshAllQuotas(): Promise<boolean> {
    const res = await this.postShieldApi<any>('/accounts/refresh', {});
    return Boolean(res && res.success);
  }

  /**
   * Installs or upgrades Antigravity Toolkit via Shield daemon CLI
   */
  public async installToolkit(ideId = 'antigravity'): Promise<{ success: boolean; message?: string; error?: string }> {
    const res = await this.postShieldApi<any>('/toolkit/install', { ide_id: ideId });
    if (res && res.success) {
      return { success: true, message: res.message || 'Installed' };
    }
    return { success: false, error: res?.error || 'Failed to install' };
  }

  /**
   * Fetches real-time token consumption metrics from Shield daemon.
   */
  public async getTokenStats(): Promise<TokenUsageStats | null> {
    try {
      const summary = await this.fetchShieldApi<any>('/api/stats/token/summary');
      if (!summary) return null;

      const [byAccount, byModel, daily] = await Promise.all([
        this.fetchShieldApi<any[]>('/api/stats/token/by-account'),
        this.fetchShieldApi<any[]>('/api/stats/token/by-model'),
        this.fetchShieldApi<any[]>('/api/stats/token/daily'),
      ]);

      let todayTokens = 0;
      let weekTokens = 0;
      if (Array.isArray(daily) && daily.length > 0) {
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const todayEntry = daily.find((d: any) => d.period === todayStr);
        if (todayEntry && typeof todayEntry.total_tokens === 'number') {
          todayTokens = todayEntry.total_tokens;
        } else {
          todayTokens = daily[daily.length - 1]?.total_tokens || 0;
        }

        // Calculate tokens for the current week (from Monday to today, or last 7 days)
        const dayOfWeek = now.getDay();
        const diffToMonday = (dayOfWeek + 6) % 7;
        const monday = new Date(now);
        monday.setDate(now.getDate() - diffToMonday);
        monday.setHours(0, 0, 0, 0);

        for (const d of daily) {
          const dDate = new Date(d.period);
          if (dDate >= monday && typeof d.total_tokens === 'number') {
            weekTokens += d.total_tokens;
          }
        }
        if (weekTokens === 0) {
          const last7 = daily.slice(-7);
          weekTokens = last7.reduce((acc, curr) => acc + (curr.total_tokens || 0), 0);
        }
      }

      return {
        totalTokens: summary.total_tokens || 0,
        totalInputTokens: summary.total_input_tokens || 0,
        totalOutputTokens: summary.total_output_tokens || 0,
        totalCachedTokens: summary.total_cached_tokens || 0,
        totalRequests: summary.total_requests || 0,
        uniqueAccounts: summary.unique_accounts || 0,
        todayTokens,
        weekTokens,
        byAccount: Array.isArray(byAccount)
          ? byAccount.map((a: any) => ({
              accountEmail: a.account_email || '',
              totalInputTokens: a.total_input_tokens || 0,
              totalOutputTokens: a.total_output_tokens || 0,
              totalCachedTokens: a.total_cached_tokens || 0,
              totalTokens: a.total_tokens || 0,
              requestCount: a.request_count || 0,
            }))
          : [],
        byModel: Array.isArray(byModel)
          ? byModel.map((m: any) => ({
              model: m.model || '',
              totalTokens: m.total_tokens || 0,
              requestCount: m.request_count || 0,
            }))
          : [],
      };
    } catch {
      return null;
    }
  }
}
