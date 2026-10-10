import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ShieldBridge } from '../bridge/shieldBridge';

export class ExtensionUpdateService {
  private static instance: ExtensionUpdateService;
  private isChecking = false;

  private constructor() {}

  public static getInstance(): ExtensionUpdateService {
    if (!ExtensionUpdateService.instance) {
      ExtensionUpdateService.instance = new ExtensionUpdateService();
    }
    return ExtensionUpdateService.instance;
  }

  /**
   * Returns current extension version from package.json
   */
  public getCurrentVersion(): string {
    const ext = vscode.extensions.getExtension('antigravity-hub.antigravity-toolkit');
    return ext?.packageJSON?.version || '2.4.2';
  }

  /**
   * Compares two semver strings: returns true if candidate is strictly newer than current
   */
  public isVersionNewer(candidate: string, current: string): boolean {
    const parse = (v: string) =>
      v
        .trim()
        .replace(/^v/i, '')
        .split('.')
        .map((n) => parseInt(n, 10) || 0);

    const candParts = parse(candidate);
    const curParts = parse(current);
    const maxLen = Math.max(candParts.length, curParts.length);

    for (let i = 0; i < maxLen; i++) {
      const c = candParts[i] || 0;
      const cur = curParts[i] || 0;
      if (c > cur) return true;
      if (c < cur) return false;
    }
    return false;
  }

  /**
   * Helper to perform HTTP/HTTPS GET request returning string body
   */
  private fetchUrl(urlStr: string, timeoutMs = 4000): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const parsed = new URL(urlStr);
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.get(
          parsed,
          {
            headers: {
              'User-Agent': 'Antigravity-Toolkit-Updater',
            },
            timeout: timeoutMs,
          },
          (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              this.fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
          }
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Helper to download binary file (e.g. VSIX)
   */
  private downloadFile(urlStr: string, destPath: string, timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const parsed = new URL(urlStr);
        const client = parsed.protocol === 'https:' ? https : http;
        const fileStream = fs.createWriteStream(destPath);
        const req = client.get(
          parsed,
          {
            headers: { 'User-Agent': 'Antigravity-Toolkit-Updater' },
            timeout: timeoutMs,
          },
          (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              fileStream.close();
              this.downloadFile(res.headers.location, destPath, timeoutMs).then(resolve).catch(reject);
              return;
            }
            if (res.statusCode !== 200) {
              fileStream.close();
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            res.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              resolve();
            });
          }
        );
        req.on('error', (err) => {
          fileStream.close();
          reject(err);
        });
        req.on('timeout', () => {
          req.destroy();
          fileStream.close();
          reject(new Error('Download timeout'));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Finds latest local bundled VSIX from Shield or local development workspace
   */
  public findLocalVsix(): { version: string; path: string } | null {
    const currentVer = this.getCurrentVersion();
    const candidates: Array<{ version: string; path: string }> = [];

    // 1. Check local Shield resources across common install locations and active workspace
    const homeDir = os.homedir();
    const shieldLocations = [
      path.join(homeDir, '.antigravity_shield', 'resources'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity Shield', 'resources'),
      path.join('C:', 'Program Files', 'Antigravity Shield', 'resources'),
    ];

    // Check if open workspace contains Shield src-tauri resources
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        shieldLocations.push(path.join(folder.uri.fsPath, 'src-tauri', 'resources'));
      }
    }

    for (const loc of shieldLocations) {
      const vsixFile = path.join(loc, 'antigravity-toolkit.vsix');
      const verFile = path.join(loc, 'toolkit_version.txt');
      if (fs.existsSync(vsixFile)) {
        let v = '2.4.2';
        if (fs.existsSync(verFile)) {
          try {
            v = fs.readFileSync(verFile, 'utf8').trim() || v;
          } catch {}
        }
        candidates.push({ version: v, path: vsixFile });
      }
    }

    // 2. Check extension bundle directory relative to __dirname
    const extBaseDir = path.resolve(__dirname, '..');
    if (fs.existsSync(extBaseDir)) {
      try {
        const files = fs.readdirSync(extBaseDir);
        for (const file of files) {
          if (file.endsWith('.vsix') && file.startsWith('antigravity-toolkit-')) {
            const vMatch = file.match(/antigravity-toolkit-([\d.]+)\.vsix/);
            if (vMatch && vMatch[1]) {
              candidates.push({ version: vMatch[1], path: path.join(extBaseDir, file) });
            }
          }
        }
      } catch {}
    }

    // Pick candidate with highest version
    let best: { version: string; path: string } | null = null;
    for (const cand of candidates) {
      if (!best || this.isVersionNewer(cand.version, best.version)) {
        best = cand;
      }
    }

    return best;
  }

  /**
   * Installs a VSIX package into the IDE using internal VS Code command or CLI fallback
   */
  public async installVsix(vsixPath: string): Promise<boolean> {
    try {
      const uri = vscode.Uri.file(vsixPath);
      // Attempt 1: Native VS Code internal command
      await vscode.commands.executeCommand('workbench.extensions.installExtension', uri);
      return true;
    } catch (e) {
      console.warn('[ExtensionUpdateService] Internal installExtension failed, trying Shield daemon:', e);
    }

    // Attempt 2: Through Shield daemon
    try {
      const shield = ShieldBridge.getInstance();
      const res = await shield.installToolkit('antigravity');
      if (res && res.success) return true;
    } catch (e) {
      console.warn('[ExtensionUpdateService] Shield daemon install failed:', e);
    }

    return false;
  }

  /**
   * Checks for newer releases and updates the extension.
   * Triggered by the spinning refresh arrow icon (antigravityToolkit.refreshAll) or interval.
   */
  public async checkAndUpdate(userInitiated = true): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      const currentVersion = this.getCurrentVersion();

      if (userInitiated) {
        vscode.window.setStatusBarMessage('$(sync~spin) Checking for Antigravity Toolkit updates...', 2500);
      }

      let updated = false;
      let newVersionFound = '';

      // 1. Check local Shield daemon & bundled VSIX
      const localCand = this.findLocalVsix();
      if (localCand && this.isVersionNewer(localCand.version, currentVersion)) {
        const ok = await this.installVsix(localCand.path);
        if (ok) {
          updated = true;
          newVersionFound = localCand.version;
        }
      }

      // 2. Check remote GitHub release if not updated locally
      if (!updated) {
        try {
          const rawPkg = await this.fetchUrl(
            'https://raw.githubusercontent.com/antigravity-hub/antigravity-toolkit-extension/main/package.json',
            3000
          );
          const parsed = JSON.parse(rawPkg);
          if (parsed && parsed.version && this.isVersionNewer(parsed.version, currentVersion)) {
            newVersionFound = parsed.version;
            // Notify user of available remote version
            const action = await vscode.window.showInformationMessage(
              `Antigravity Toolkit v${parsed.version} is available! (Current: v${currentVersion})`,
              'Sync & Install from Shield',
              'Dismiss'
            );
            if (action === 'Sync & Install from Shield') {
              const res = await ShieldBridge.getInstance().installToolkit('antigravity');
              if (res.success) {
                const reload = await vscode.window.showInformationMessage(
                  `Antigravity Toolkit updated to v${parsed.version}! Please reload to apply.`,
                  'Reload Window'
                );
                if (reload === 'Reload Window') {
                  vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
                return;
              }
            }
          }
        } catch {
          // offline or private repository - fallback to Shield
        }
      }

      if (updated) {
        const choice = await vscode.window.showInformationMessage(
          `Antigravity Toolkit has been updated to v${newVersionFound}! Reload window to apply changes.`,
          'Reload Window',
          'Later'
        );
        if (choice === 'Reload Window') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else if (userInitiated) {
        vscode.window.showInformationMessage(
          `Antigravity Toolkit is up to date (v${currentVersion}) • Telemetry synced.`
        );
      }
    } catch (err: any) {
      if (userInitiated) {
        vscode.window.showErrorMessage(`Update check error: ${err.message || String(err)}`);
      }
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Initializes periodic update checking in the background (every 6 hours)
   */
  public initBackgroundSchedule(): vscode.Disposable {
    // Check once 15 seconds after activation
    const initialTimer = setTimeout(() => {
      this.checkAndUpdate(false);
    }, 15000);

    // Recurring interval: every 6 hours
    const intervalTimer = setInterval(() => {
      this.checkAndUpdate(false);
    }, 6 * 3600 * 1000);

    return new vscode.Disposable(() => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    });
  }
}
