import * as vscode from 'vscode';
import * as http from 'http';
import { Account } from '../types';

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
      return this.pingUrl(url);
    } catch {
      return false;
    }
  }

  private fetchFromUrl(url: URL): Promise<Account[]> {
    return new Promise((resolve) => {
      try {
        const req = http.get(url, { timeout: 3000 }, (res) => {
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
                tier: acc.tier || (acc.quota && acc.quota.subscription_tier) || 'Pro',
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
   * Fetches the complete accounts list and active status from Antigravity Shield.
   */
  public async fetchShieldAccounts(): Promise<Account[]> {
    const baseUrl = await this.getBaseUrl();
    const endpoints = ['/api/toolkit/accounts', '/api/accounts'];
    for (const ep of endpoints) {
      const accounts = await this.fetchFromUrl(new URL(ep, baseUrl));
      if (accounts.length > 0) {
        return accounts;
      }
    }
    return [];
  }

  /**
   * Notifies Shield that an account switch was triggered from the IDE.
   */
  public async notifyShieldSwitch(email: string): Promise<boolean> {
    const baseUrl = await this.getBaseUrl();
    const endpoints = ['/api/toolkit/switch', '/api/switch', '/api/accounts/switch'];
    const body = JSON.stringify({ email, account_id: email, target_ide: 'ide' });

    for (const ep of endpoints) {
      const ok = await new Promise<boolean>((resolve) => {
        try {
          const url = new URL(ep, baseUrl);
          const req = http.request(
            url,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
              timeout: 3000,
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
        } catch {
          resolve(false);
        }
      });
      if (ok) return true;
    }
    return false;
  }

  /**
   * Proactively announces Toolkit availability to Shield via heartbeat.
   */
  public async sendHeartbeat(activeEmail?: string): Promise<boolean> {
    const payload = JSON.stringify({
      ide: vscode.env.appName || 'Antigravity IDE',
      version: '1.0.0',
      active_email: activeEmail || null,
    });

    const ports = [8045, 8765, 19527];
    for (const port of ports) {
      try {
        const url = new URL(`http://127.0.0.1:${port}/api/toolkit/heartbeat`);
        const ok = await new Promise<boolean>((resolve) => {
          const req = http.request(
            url,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              },
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
        // try next port
      }
    }
    return false;
  }
}
