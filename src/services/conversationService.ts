import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import { ConversationSession, ConversationStep } from '../types';

export class ConversationService {
  private static instance: ConversationService;
  private onDidChangeConversationsEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeConversations = this.onDidChangeConversationsEmitter.event;

  private trajectoryMap: Map<string, { title: string; workspace?: string }> = new Map();
  private lastTrajectoryLoad = 0;

  private constructor() {}

  public static getInstance(): ConversationService {
    if (!ConversationService.instance) {
      ConversationService.instance = new ConversationService();
    }
    return ConversationService.instance;
  }

  /**
   * Resolves the Antigravity Brain storage directory.
   */
  private getBrainDirectories(): string[] {
    const homeDir = os.homedir();
    const dirs: string[] = [
      path.join(homeDir, '.gemini', 'antigravity', 'brain'),
      path.join(homeDir, '.gemini', 'antigravity-ide', 'brain'),
      path.join(homeDir, '.gemini', 'brain'),
    ];

    // Check workspace root folders
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        dirs.push(path.join(folder.uri.fsPath, '.gemini', 'brain'));
        dirs.push(path.join(folder.uri.fsPath, '.gemini', 'antigravity', 'brain'));
        dirs.push(path.join(folder.uri.fsPath, '.gemini', 'antigravity-ide', 'brain'));
      }
    }

    return dirs.filter((d) => fs.existsSync(d));
  }

  /**
   * Discovers all real project/workspace folder names from IDE storage and active workspace.
   */
  private getKnownWorkspaceNames(): string[] {
    const known = new Set<string>();
    const ignored = new Set([
      'appdata', 'desktop', 'public', 'users', 'references', 'bot codes', 'v4',
      'programs', 'antigravity', 'gro', 'site data', 'site', 'scratch', 'logs',
      'tasks', 'brain', 'system_generated'
    ]);

    // 1. Current workspace folders in VS Code / Antigravity IDE
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        if (folder.name && !ignored.has(folder.name.toLowerCase())) {
          known.add(folder.name);
        }
      }
    }

    // 2. Discover from IDE workspaceStorage (Antigravity IDE, Cursor, Code)
    const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : '');
    if (appData) {
      const storageRoots = [
        path.join(appData, 'Antigravity IDE', 'User', 'workspaceStorage'),
        path.join(appData, 'Cursor', 'User', 'workspaceStorage'),
        path.join(appData, 'Code', 'User', 'workspaceStorage'),
      ];

      for (const root of storageRoots) {
        if (!fs.existsSync(root)) continue;
        try {
          const dirs = fs.readdirSync(root, { withFileTypes: true });
          for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const wsJsonPath = path.join(root, d.name, 'workspace.json');
            if (fs.existsSync(wsJsonPath)) {
              try {
                const data = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
                const folderUrl: string = data.folder || '';
                if (folderUrl) {
                  const unquoted = decodeURIComponent(folderUrl);
                  const clean = unquoted.replace(/^file:\/\/\/?/, '').replace(/^([a-zA-Z])%3A/i, '$1:');
                  const bName = path.basename(path.normalize(clean));
                  if (bName && bName.length > 2 && !ignored.has(bName.toLowerCase())) {
                    known.add(bName);
                  }
                }
              } catch {
                // ignore
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // 3. Fallback well-known core projects
    const fallbackProjects = [
      'Antigravity-Manager-Guidance',
      'antigravity-toolkit-extension',
      'Guidegram',
      'FastStars',
      'modern-faststars-site',
      'DoctorGuidance',
      'keshiko',
      'medflip',
      'memsys',
      'v2rayGuardBot',
      'v2rayGuard',
      'betwithton',
      'mentogether',
      'drguidance_manager',
      'Calibion-Orderer',
      'roohchat',
      'nabz-e-danesh',
      'drugs-repo',
      'synapse',
      'hospital-codes',
      'trade agent',
      'atrclick',
    ];
    for (const p of fallbackProjects) {
      known.add(p);
    }

    // Sort by length descending so longer specific names match first
    return Array.from(known).sort((a, b) => b.length - a.length);
  }

  /**
   * Loads official conversation titles and workspaces from state.vscdb
   * (antigravityUnifiedStateSync.trajectorySummaries) with zero lag.
   */
  private loadTrajectorySummaries(): void {
    const now = Date.now();
    if (this.trajectoryMap.size > 0 && now - this.lastTrajectoryLoad < 30000) {
      return;
    }

    try {
      const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : '');
      const dbPath = path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
      if (!fs.existsSync(dbPath)) return;

      const val = child_process
        .execSync(
          `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';"`,
          { maxBuffer: 25 * 1024 * 1024, timeout: 5000 }
        )
        .toString()
        .trim();

      if (!val) return;

      const buf = Buffer.from(val, 'base64');
      const text = buf.toString('latin1');
      const regex = /\$([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        const uuid = match[1];
        const offset = match.index;
        const windowStart = Math.max(0, offset - 500);
        const windowEnd = Math.min(text.length, offset + 1500);
        const chunk = text.slice(windowStart, windowEnd);

        const b64Regex = /([A-Za-z0-9+/=]{40,})/g;
        let b64Match: RegExpExecArray | null;
        while ((b64Match = b64Regex.exec(chunk)) !== null) {
          try {
            const decoded = Buffer.from(b64Match[1], 'base64');
            if (decoded[0] === 0x0a) {
              let len = decoded[1];
              let titleStart = 2;
              if (len & 0x80) {
                len = (len & 0x7f) | (decoded[2] << 7);
                titleStart = 3;
              }
              const title = decoded.slice(titleStart, titleStart + len).toString('utf8');
              if (title.length > 2 && !this.trajectoryMap.has(uuid)) {
                const decodedStr = decoded.toString('utf8');
                const fileMatch = decodedStr.match(/file:\/\/\/([^\s\x00-\x1f"']+)/);
                let workspace: string | undefined;
                if (fileMatch) {
                  const rawPath = decodeURIComponent(fileMatch[0]);
                  const clean = rawPath.replace(/^file:\/\/\/?/, '').replace(/^([a-zA-Z])%3A/i, '$1:');
                  workspace = path.basename(path.normalize(clean));
                }
                this.trajectoryMap.set(uuid, { title, workspace });
              }
            }
          } catch {
            // ignore
          }
        }
      }
      this.lastTrajectoryLoad = now;
    } catch (e) {
      console.warn('[ConversationService] Failed to load trajectory summaries:', e);
    }
  }

  /**
   * Scans and returns all discovered conversations sorted by latest activity.
   */
  public async getConversations(): Promise<ConversationSession[]> {
    this.loadTrajectorySummaries();
    const brainDirs = this.getBrainDirectories();
    const knownWorkspaces = this.getKnownWorkspaceNames();
    const sessions: ConversationSession[] = [];
    const seenIds = new Set<string>();

    for (const brainDir of brainDirs) {
      try {
        const entries = fs.readdirSync(brainDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.') || entry.name.toLowerCase().includes('tempmedia')) continue;
          if (seenIds.has(entry.name)) continue;

          const convId = entry.name;
          const sessionDir = path.join(brainDir, convId);
          const logsDir = path.join(sessionDir, '.system_generated', 'logs');
          const transcriptCompact = path.join(logsDir, 'transcript.jsonl');
          const transcriptFull = path.join(logsDir, 'transcript_full.jsonl');

          const transcriptPath = fs.existsSync(transcriptCompact)
            ? transcriptCompact
            : fs.existsSync(transcriptFull)
            ? transcriptFull
            : '';

          // Only treat as real session if transcript exists
          if (!transcriptPath || !fs.existsSync(transcriptPath)) {
            continue;
          }

          let stepCount = 0;
          let previewText = '';
          let mtime = 0;

          try {
            const stat = fs.statSync(transcriptPath);
            mtime = stat.mtimeMs;
          } catch {
            mtime = Date.now();
          }

          let projectName = '';
          let tokenEstimate = 0;

          try {
            const content = fs.readFileSync(transcriptPath, 'utf8');
            const lines = content.split('\n').filter((l) => l.trim().length > 0);
            stepCount = lines.length;
            tokenEstimate = Math.round(content.length / 3.8);

            // Accurate matching: match against real known workspaces in transcript content
            const sampleContent = content.slice(0, 120000);
            const sampleLower = sampleContent.toLowerCase();

            for (const kw of knownWorkspaces) {
              if (sampleLower.includes(kw.toLowerCase())) {
                projectName = kw;
                break;
              }
            }

            // Extract first clean user input as title / preview
            for (const line of lines.slice(0, 40)) {
              try {
                const obj = JSON.parse(line);

                if (obj.type === 'USER_INPUT' && obj.content && !previewText) {
                  let cleaned = String(obj.content)
                    .replace(/<USER_REQUEST>[\s\S]*?<\/USER_REQUEST>/g, (m) => m.replace(/<\/?USER_REQUEST>/g, ''))
                    .replace(/<[^>]+>/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                  if (cleaned.length > 0) {
                    previewText = cleaned.slice(0, 90);
                  }
                }
              } catch {
                // ignore JSON parse errors on malformed lines
              }
            }
          } catch {
            // ignore file read error
          }

          let finalTitle = previewText;
          const traj = this.trajectoryMap.get(convId);
          if (traj?.title) {
            finalTitle = traj.title;
          }
          if (traj?.workspace) {
            projectName = traj.workspace;
          }

          if (stepCount === 0 && !finalTitle) {
            continue;
          }

          seenIds.add(convId);

          const date = new Date(mtime);
          const dateFormatted = date.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });

          sessions.push({
            id: convId,
            title: finalTitle || `Session ${convId.slice(0, 8)}`,
            createdAt: mtime,
            updatedAt: mtime,
            dateFormatted,
            transcriptPath,
            stepCount,
            previewText,
            projectName: projectName || 'General Workspace',
            tokenEstimate: tokenEstimate || stepCount * 1400,
          });
        }
      } catch (err) {
        console.warn(`[ConversationService] Failed to read ${brainDir}:`, err);
      }
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  }

  /**
   * Opens the transcript file or visual transcript document in the editor.
   */
  public async openTranscript(session: ConversationSession): Promise<void> {
    if (!session.transcriptPath || !fs.existsSync(session.transcriptPath)) {
      vscode.window.showWarningMessage(`No transcript found for session ${session.id}`);
      return;
    }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(session.transcriptPath));
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  public refresh(): void {
    this.onDidChangeConversationsEmitter.fire();
  }
}
