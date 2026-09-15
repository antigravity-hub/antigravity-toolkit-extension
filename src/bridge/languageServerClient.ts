import * as http from 'http';
import * as https from 'https';
import * as child_process from 'child_process';
import { promisify } from 'util';
import { Account } from '../types';

const execAsync = promisify(child_process.exec);

export interface LSEndpoint {
  port: number;
  csrfToken: string;
  pid: string;
}

export const MODEL_FRIENDLY_NAMES: Record<string, string> = {
  MODEL_PLACEHOLDER_M318: 'Gemini 3.0 Flash High',
  MODEL_PLACEHOLDER_M319: 'Gemini 3.0 Flash Medium',
  MODEL_PLACEHOLDER_M320: 'Gemini 3.0 Flash Low',
  MODEL_PLACEHOLDER_M298: 'Gemini 3.7 Flash (High)',
  MODEL_PLACEHOLDER_M299: 'Gemini 3.7 Flash (Medium)',
  MODEL_PLACEHOLDER_M300: 'Gemini 3.7 Flash (Low)',
  MODEL_PLACEHOLDER_M71: 'Gemini 3.6 Flash (High)',
  MODEL_PLACEHOLDER_M72: 'Gemini 3.6 Flash (Medium)',
  MODEL_PLACEHOLDER_M73: 'Gemini 3.6 Flash (Low)',
  MODEL_PLACEHOLDER_M16: 'Gemini 3.1 Pro (High)',
  MODEL_PLACEHOLDER_M36: 'Gemini 3.1 Pro (Low)',
  MODEL_PLACEHOLDER_M35: 'Claude Sonnet 4.6 (Thinking)',
  MODEL_PLACEHOLDER_M26: 'Claude Opus 4.6 (Thinking)',
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 'GPT-OSS 120B (Medium)',
  'gemini-3.0-flash-medium': 'Gemini 3.0 Flash Medium',
  'gemini-3.0-flash-high': 'Gemini 3.0 Flash High',
  'gemini-3.0-flash-low': 'Gemini 3.0 Flash Low',
  'gemini-3.7-flash-high': 'Gemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium': 'Gemini 3.7 Flash (Medium)',
  'gemini-3.7-flash-low': 'Gemini 3.7 Flash (Low)',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
};

export class LanguageServerClient {
  private static instance: LanguageServerClient;
  private cachedEndpoints: LSEndpoint[] = [];
  private lastEndpointsDiscovery = 0;
  private cachedActiveModel: string | null = null;
  private lastModelCheck = 0;

  public static getInstance(): LanguageServerClient {
    if (!LanguageServerClient.instance) {
      LanguageServerClient.instance = new LanguageServerClient();
    }
    return LanguageServerClient.instance;
  }

  /**
   * Discovers active Antigravity Language Server processes and their TCP listening ports.
   */
  public async findLSEndpoints(forceRefresh = false): Promise<LSEndpoint[]> {
    const now = Date.now();
    if (!forceRefresh && this.cachedEndpoints.length > 0 && now - this.lastEndpointsDiscovery < 15000) {
      return this.cachedEndpoints;
    }

    const endpoints: LSEndpoint[] = [];
    const isWindows = process.platform === 'win32';

    try {
      if (isWindows) {
        const ps = `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.ProcessName -like '*language_server*' -or $_.CommandLine -like '*language_server*' } | Select-Object -Property ProcessId, CommandLine | ForEach-Object { $_.ProcessId.ToString() + '###' + $_.CommandLine }"`;
        const { stdout } = await execAsync(ps, { timeout: 6000 });
        const lines = stdout.split('\n');
        const candidates: { pid: string; csrfToken: string }[] = [];

        for (const line of lines) {
          if (!line.includes('###')) continue;
          const [pidStr, cmdLine] = line.split('###');
          const pid = pidStr.trim();
          const csrfMatch = cmdLine.match(/--csrf_token[\s=]+([\w-]+)/);
          if (pid && csrfMatch) {
            candidates.push({ pid, csrfToken: csrfMatch[1] });
          }
        }

        if (candidates.length > 0) {
          const { stdout: netstatOut } = await execAsync('netstat -ano -p TCP', { timeout: 6000 });
          for (const cand of candidates) {
            for (const nLine of netstatOut.split('\n')) {
              if (nLine.includes('LISTENING') && nLine.trim().endsWith(cand.pid)) {
                const parts = nLine.trim().split(/\s+/);
                const m = parts[1]?.match(/:(\d+)$/);
                if (m) {
                  endpoints.push({ port: parseInt(m[1], 10), csrfToken: cand.csrfToken, pid: cand.pid });
                }
              }
            }
          }
        }
      } else {
        const { stdout } = await execAsync('ps -A -ww -o pid,args | grep language_server | grep -v grep', { timeout: 5000 });
        const lines = stdout.split('\n');
        for (const line of lines) {
          const pidMatch = line.trim().match(/^(\d+)\s/);
          const csrfMatch = line.match(/--csrf_token[\s=]+([\w-]+)/);
          if (pidMatch && csrfMatch) {
            const pid = pidMatch[1];
            try {
              const { stdout: lsofOut } = await execAsync(`lsof -Pan -p ${pid} -i TCP -sTCP:LISTEN 2>/dev/null`, { timeout: 3000 });
              for (const lLine of lsofOut.split('\n')) {
                const portMatch = lLine.match(/:(\d+)\s+\(LISTEN\)/);
                if (portMatch) {
                  endpoints.push({ port: parseInt(portMatch[1], 10), csrfToken: csrfMatch[1], pid });
                }
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } catch (err) {
      console.warn('[LanguageServerClient] Endpoint discovery error:', err);
    }

    this.cachedEndpoints = endpoints;
    this.lastEndpointsDiscovery = now;
    return endpoints;
  }

  /**
   * Performs a POST call to an Antigravity Language Server endpoint.
   * Language servers run an HTTPS Connect-RPC server on their primary port (--https_server_port).
   * Attempts HTTPS first (with rejectUnauthorized: false), falling back to HTTP if SSL fails.
   */
  public async callLs<T = any>(
    port: number,
    csrfToken: string,
    method: string,
    body: any = {},
    timeoutMs = 3000
  ): Promise<T | null> {
    const fullPath = method.startsWith('/')
      ? method
      : `/exa.language_server_pb.LanguageServerService/${method}`;
    const bodyStr = JSON.stringify(body);

    const makeRequest = (isHttps: boolean): Promise<T | null> => {
      const transport: any = isHttps ? https : http;
      return new Promise((resolve) => {
        const req = transport.request(
          {
            hostname: '127.0.0.1',
            port,
            path: fullPath,
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr),
              'Connect-Protocol-Version': '1',
              'X-Codeium-Csrf-Token': csrfToken,
            },
            timeout: timeoutMs,
          },
          (res: http.IncomingMessage) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  resolve(JSON.parse(data));
                } catch {
                  resolve(data as any);
                }
              } else {
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
        req.write(bodyStr);
        req.end();
      });
    };

    // Try HTTPS first (standard for Antigravity Language Server Connect-RPC)
    const httpsRes = await makeRequest(true);
    if (httpsRes !== null) {
      return httpsRes;
    }
    // Fall back to HTTP for plain HTTP endpoints
    return makeRequest(false);
  }

  /**
   * Calls RegisterGdmUser across all active Language Server endpoints to hot-swap
   * credentials in memory immediately with zero reload.
   */
  public async callRegisterGdmUser(): Promise<boolean> {
    const endpoints = await this.findLSEndpoints(true);
    if (endpoints.length === 0) return false;

    let anySuccess = false;
    await Promise.allSettled(
      endpoints.map(async (ep) => {
        const res = await this.callLs(ep.port, ep.csrfToken, 'RegisterGdmUser', {});
        if (res !== null) {
          anySuccess = true;
        }
      })
    );

    return anySuccess;
  }

  /**
   * Triggers a soft restart of active Language Server processes in memory.
   */
  public async callRestart(): Promise<boolean> {
    const endpoints = await this.findLSEndpoints(true);
    if (endpoints.length === 0) return false;

    let anySuccess = false;
    await Promise.allSettled(
      endpoints.map(async (ep) => {
        const res = await this.callLs(ep.port, ep.csrfToken, 'Restart', {});
        if (res !== null) {
          anySuccess = true;
        }
      })
    );
    return anySuccess;
  }

  /**
   * Fetches cascade model config data directly from the active language server.
   */
  public async getCascadeModelConfigData(): Promise<any | null> {
    const endpoints = await this.findLSEndpoints();
    for (const ep of endpoints) {
      try {
        const res = await this.callLs(ep.port, ep.csrfToken, 'GetCascadeModelConfigData', {});
        if (res && res.clientModelConfigs) {
          return res;
        }
      } catch {
        // try next
      }
    }
    return null;
  }

  /**
   * Legacy wrapper: maintains compatibility with existing calls.
   */
  public async registerUserInMemory(account: Account): Promise<boolean> {
    return this.callRegisterGdmUser();
  }

  /**
   * Fetches the user status and available models from the active language server.
   */
  public async getUserStatus(): Promise<any | null> {
    const endpoints = await this.findLSEndpoints();
    for (const ep of endpoints) {
      try {
        const res = await this.callLs(ep.port, ep.csrfToken, 'GetUserStatus', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
        });
        if (res && res.userStatus) {
          return res.userStatus;
        }
      } catch {
        // try next
      }
    }
    return null;
  }

  /**
   * Dynamically resolves the currently active model selected in the IDE / Antigravity Chat.
   */
  public async getActiveChatModel(cascadeId?: string): Promise<string> {
    const now = Date.now();
    if (this.cachedActiveModel && now - this.lastModelCheck < 10000) {
      return this.cachedActiveModel;
    }

    const endpoints = await this.findLSEndpoints();

    // 1. Try cascade trajectory inference data
    if (cascadeId) {
      for (const ep of endpoints) {
        try {
          const traj = await this.callLs(ep.port, ep.csrfToken, 'GetCascadeTrajectory', { cascadeId });
          const steps = traj?.trajectory?.steps || [];
          for (let i = steps.length - 1; i >= 0; i--) {
            const raw = steps[i].metadata?.generatorModel || steps[i].metadata?.modelUsage?.model;
            if (raw) {
              const friendly = MODEL_FRIENDLY_NAMES[raw] || raw;
              this.cachedActiveModel = friendly;
              this.lastModelCheck = now;
              return friendly;
            }
          }
        } catch {
          // not cascade server
        }
      }
    }

    // 2. Check userStatus from Language Server
    for (const ep of endpoints) {
      try {
        const res = await this.callLs(ep.port, ep.csrfToken, 'GetUserStatus', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
        });
        const override = res?.userStatus?.cascadeModelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model;
        if (override) {
          const friendly = MODEL_FRIENDLY_NAMES[override] || override;
          this.cachedActiveModel = friendly;
          this.lastModelCheck = now;
          return friendly;
        }

        const configs = res?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
        if (Array.isArray(configs) && configs.length > 0) {
          const rec = configs.find((c: any) => c.isRecommended) || configs[0];
          if (rec && rec.label) {
            const label = rec.label.replace('3.8', '3.0');
            this.cachedActiveModel = label;
            this.lastModelCheck = now;
            return label;
          }
        }
      } catch {
        // try next
      }
    }

    // Fallback default
    this.cachedActiveModel = 'Gemini 3.0 Flash Medium';
    this.lastModelCheck = now;
    return this.cachedActiveModel;
  }
}
