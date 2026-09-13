import * as vscode from 'vscode';
import * as http from 'http';
import { Account } from '../types';

export class ShieldBridge {
  private static instance: ShieldBridge;

  public static getInstance(): ShieldBridge {
    if (!ShieldBridge.instance) {
      ShieldBridge.instance = new ShieldBridge();
    }
    return ShieldBridge.instance;
  }

  private getBaseUrl(): string {
    const config = vscode.workspace.getConfiguration('antigravityToolkit');
    return config.get<string>('shieldApiUrl', 'http://127.0.0.1:8765');
  }

  /**
   * Health check to detect if Antigravity Shield desktop or daemon is active.
   */
  public async isShieldOnline(): Promise<boolean> {
    try {
      const url = new URL('/api/health', this.getBaseUrl());
      return new Promise((resolve) => {
        const req = http.get(url, { timeout: 1500 }, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
    } catch {
      return false;
    }
  }

  /**
   * Fetches the complete accounts list and active status from Antigravity Shield.
   */
  public async fetchShieldAccounts(): Promise<Account[]> {
    return new Promise((resolve) => {
      try {
        const url = new URL('/api/accounts', this.getBaseUrl());
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
              const accounts: Account[] = (json.accounts || json || []).map((acc: any) => ({
                id: acc.id || acc.email,
                email: acc.email,
                name: acc.name || acc.email.split('@')[0],
                avatarUrl: acc.avatarUrl || acc.picture,
                isActive: !!acc.isActive || !!acc.is_active,
                tier: acc.tier || 'Pro',
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
   * Notifies Shield that an account switch was triggered from the IDE.
   */
  public async notifyShieldSwitch(email: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const url = new URL('/api/switch', this.getBaseUrl());
        const body = JSON.stringify({ email, target_ide: 'ide' });
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
          (res) => resolve(res.statusCode === 200)
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

    const ports = [8765, 19527];
    for (const port of ports) {
      try {
        const url = new URL(`http://127.0.0.1:${port}/toolkit/heartbeat`);
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
