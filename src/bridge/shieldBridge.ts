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

  private pingUrl(url: URL): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(url, { timeout: 1000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  public async getBaseUrl(): Promise<string> {
    if (this.detectedBaseUrl) return this.detectedBaseUrl;
    const config = vscode.workspace.getConfiguration('antigravityToolkit');
    const configured = config.get<string>('shieldApiUrl');
    if (configured && configured !== 'http://127.0.0.1:8765' && configured !== 'http://127.0.0.1:8045') {
      return configured;
    }

    // Auto-detect between 8045 (standard Shield port) and 8765 (bridge port)
    for (const candidate of ['http://127.0.0.1:8045', 'http://127.0.0.1:8765']) {
      try {
        const ok = await this.pingUrl(new URL('/api/health', candidate));
        if (ok) {
          this.detectedBaseUrl = candidate;
          return candidate;
        }
      } catch {
        // try next
      }
    }
    return 'http://127.0.0.1:8045';
  }

  /**
   * Health check to detect if Antigravity Shield desktop or daemon is active.
   */
  public async isShieldOnline(): Promise<boolean> {
    try {
      const baseUrl = await this.getBaseUrl();
      const url = new URL('/api/health', baseUrl);
      const isOnline = await this.pingUrl(url);
      if (isOnline) return true;
    } catch {
      // continue to local check
    }

    try {
      const home = os.homedir();
      const shieldDir = path.join(home, '.antigravity_shield');
      return fs.existsSync(shieldDir);
    } catch {
      return false;
    }
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

        const detailPath = path.join(shieldDir, 'accounts', `${acc.id}.json`);
        if (fs.existsSync(detailPath)) {
          try {
            const detail = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
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
                      const remaining = typeof b.remaining_fraction === 'number'
                        ? Math.round(b.remaining_fraction * 100)
                        : typeof b.percentage === 'number'
                        ? b.percentage
                        : 100;
                      const resetMs = b.reset_time ? new Date(b.reset_time).getTime() : Date.now() + 5 * 3600 * 1000;
                      const durationMs = Math.max(0, resetMs - Date.now());
                      const hours = Math.floor(durationMs / (1000 * 60 * 60));
                      const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
                      const resetFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

                      const bucket: import('../types').QuotaBucket = {
                        bucketId: b.bucket_id || b.window,
                        window: b.window === 'weekly' ? 'weekly' : '5h',
                        remainingPercentage: remaining,
                        resetTimeMs: resetMs,
                        resetTimeFormatted: resetFormatted,
                        displayName: b.display_name || (b.window === 'weekly' ? 'Weekly Limit' : '5-Hour Limit'),
                      };

                      if (b.window === 'weekly') {
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
                  const hours = Math.floor(durationMs / (1000 * 60 * 60));
                  const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
                  const resetFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

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
   * Notifies Shield that an account switch was triggered from the IDE,
   * and synchronizes local configuration files (~/.antigravity_shield & ~/.gemini).
   */
  public async notifyShieldSwitch(email: string): Promise<boolean> {
    const baseUrl = await this.getBaseUrl();
    const endpoints = ['/api/toolkit/switch', '/toolkit/switch', '/api/switch', '/api/accounts/switch'];
    const body = JSON.stringify({ email, account_id: email, target_ide: 'ide' });

    for (const ep of endpoints) {
      try {
        const ok = await new Promise<boolean>((resolve) => {
          const url = new URL(ep, baseUrl);
          const req = http.request(
            url,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
              timeout: 2000,
            },
            (res) => resolve(res.statusCode === 200 || res.statusCode === 202)
          );

          req.on('error', () => resolve(false));
          req.on('timeout', () => {
            req.destroy();
            resolve(false);
          });

          req.write(body);
          req.end();
        });
        if (ok) break;
      } catch {
        // ignore
      }
    }

    // Always update local disk configuration for instant synchronization
    try {
      const home = os.homedir();
      const shieldDir = path.join(home, '.antigravity_shield');
      const accountsJsonPath = path.join(shieldDir, 'accounts.json');
      if (fs.existsSync(accountsJsonPath)) {
        const index = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
        const target = index.accounts.find((a: any) => a.email.toLowerCase() === email.toLowerCase());
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
        }
      }
    } catch {
      // ignore
    }

    return true;
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

    const targets = [
      { port: 8045, path: '/api/toolkit/heartbeat' },
      { port: 8045, path: '/toolkit/heartbeat' },
      { port: 8765, path: '/toolkit/heartbeat' },
      { port: 19527, path: '/api/toolkit/heartbeat' },
    ];

    for (const target of targets) {
      try {
        const url = new URL(`http://127.0.0.1:${target.port}${target.path}`);
        const ok = await new Promise<boolean>((resolve) => {
          const req = http.request(
            url,
            {
              method: 'POST',
              headers,
              timeout: 1000,
            },
            (res) => resolve(res.statusCode === 200 || res.statusCode === 204)
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
      if (Array.isArray(daily) && daily.length > 0) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const todayEntry = daily.find((d: any) => d.period === todayStr);
        if (todayEntry && typeof todayEntry.total_tokens === 'number') {
          todayTokens = todayEntry.total_tokens;
        } else {
          todayTokens = daily[daily.length - 1]?.total_tokens || 0;
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
