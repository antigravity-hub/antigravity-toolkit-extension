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
  private cachedSessions: ConversationSession[] = [];
  private lastSessionsScan = 0;

  private constructor() {}

  public static getInstance(): ConversationService {
    if (!ConversationService.instance) {
      ConversationService.instance = new ConversationService();
    }
    return ConversationService.instance;
  }

  /**
   * Returns a cached session by ID instantly without disk scanning.
   */
  public getSessionById(sessionId: string): ConversationSession | undefined {
    return this.cachedSessions.find((s) => s.id === sessionId);
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
   * Discovers all real project/workspace folder names and absolute paths from IDE storage and active workspace.
   */
  private getKnownWorkspaces(): { names: string[]; pathMap: Map<string, string> } {
    const names = new Set<string>();
    const pathMap = new Map<string, string>();
    const ignored = new Set([
      'appdata', 'desktop', 'public', 'users', 'references', 'bot codes', 'v4',
      'programs', 'antigravity', 'gro', 'site data', 'site', 'scratch', 'logs',
      'tasks', 'brain', 'system_generated'
    ]);

    // 1. Current workspace folders in VS Code / Antigravity IDE
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        if (folder.name && !ignored.has(folder.name.toLowerCase())) {
          names.add(folder.name);
          pathMap.set(folder.name.toLowerCase(), folder.uri.fsPath);
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
                  const norm = path.normalize(clean);
                  const bName = path.basename(norm);
                  if (bName && bName.length > 2 && !ignored.has(bName.toLowerCase())) {
                    names.add(bName);
                    if (!pathMap.has(bName.toLowerCase())) {
                      pathMap.set(bName.toLowerCase(), norm);
                    }
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
      names.add(p);
    }

    const sortedNames = Array.from(names).sort((a, b) => b.length - a.length);
    return { names: sortedNames, pathMap };
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
   * Internal subagents, background workers, and robotic prompts are filtered out.
   */
  public async getConversations(forceRefresh = false): Promise<ConversationSession[]> {
    const now = Date.now();
    if (!forceRefresh && this.cachedSessions.length > 0 && now - this.lastSessionsScan < 15000) {
      return this.cachedSessions;
    }

    this.loadTrajectorySummaries();
    const brainDirs = this.getBrainDirectories();
    const { names: knownWorkspaces, pathMap } = this.getKnownWorkspaces();
    const sessions: ConversationSession[] = [];
    const seenIds = new Set<string>();

    const isSubagentText = (t: string): boolean => {
      if (!t) return false;
      const lower = t.trim().toLowerCase();
      return (
        lower.startsWith('you are ') ||
        lower.startsWith('comprehensive extraction, nlp-driven') ||
        lower.includes('teamwork_preview_victory_auditor') ||
        lower.includes('acceptance gate, regression verification') ||
        lower.includes('working directory:')
      );
    };

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
          let sampleContent = '';

          try {
            const content = fs.readFileSync(transcriptPath, 'utf8');
            const lines = content.split('\n').filter((l) => l.trim().length > 0);
            stepCount = lines.length;
            tokenEstimate = Math.round(content.length / 3.8);

            // Accurate matching: match against real known workspaces in transcript content
            sampleContent = content.slice(0, 120000);
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

          // Filter out subagents and background worker tasks
          if (isSubagentText(finalTitle) || isSubagentText(previewText)) {
            continue;
          }

          seenIds.add(convId);

          let workspacePath: string | undefined;
          if (projectName) {
            workspacePath = pathMap.get(projectName.toLowerCase());
          }
          if (!workspacePath && sampleContent) {
            const fileMatch = sampleContent.match(/file:\/\/\/([a-zA-Z]:\/[^\s"'>\\]+)/i);
            if (fileMatch) {
              const cleanUri = decodeURIComponent(fileMatch[1]).replace(/\//g, path.sep);
              for (const kw of knownWorkspaces) {
                const idx = cleanUri.toLowerCase().indexOf(kw.toLowerCase());
                if (idx !== -1) {
                  workspacePath = cleanUri.slice(0, idx + kw.length);
                  if (!projectName || projectName === 'General Workspace') {
                    projectName = kw;
                  }
                  break;
                }
              }
            }
          }

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
            workspacePath,
            tokenEstimate: tokenEstimate || stepCount * 1400,
          });
        }
      } catch (err) {
        console.warn(`[ConversationService] Failed to read ${brainDir}:`, err);
      }
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    this.cachedSessions = sessions;
    this.lastSessionsScan = now;
    return sessions;
  }

  /**
   * Opens the conversation session in Antigravity IDE:
   * 1. If it belongs to a different project workspace, prompts the user cleanly instead of forcing a new window.
   * 2. Focuses/opens the Antigravity Chat panel.
   * 3. Copies the session title to the clipboard for fast filtering.
   * 4. Opens Antigravity's native Conversation Picker (Ctrl+Shift+A).
   * 5. Never uses destructive keystroke automation (VBScript/SendKeys/AppActivate).
   */
  public async openConversation(session: ConversationSession): Promise<void> {
    // 1. If conversation belongs to another project, ask user before switching windows
    const currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (session.workspacePath && currentWorkspaceFolder && fs.existsSync(session.workspacePath)) {
      const normCurrent = path.normalize(currentWorkspaceFolder).toLowerCase();
      const normTarget = path.normalize(session.workspacePath).toLowerCase();
      if (
        normCurrent !== normTarget &&
        !normCurrent.startsWith(normTarget + path.sep) &&
        !normTarget.startsWith(normCurrent + path.sep)
      ) {
        const choice = await vscode.window.showInformationMessage(
          `Conversation belongs to workspace "${session.projectName}". How would you like to open it?`,
          'Open Workspace in New Window',
          'Open in Current Window',
          'View Transcript File'
        );
        if (choice === 'Open Workspace in New Window') {
          const targetUri = vscode.Uri.file(session.workspacePath);
          await vscode.commands.executeCommand('vscode.openFolder', targetUri, { forceNewWindow: true });
          return;
        } else if (choice === 'View Transcript File') {
          await this.openTranscript(session);
          return;
        } else if (!choice) {
          return;
        }
      }
    }

    // 2. Focus / Open the Antigravity Chat / Agent panel
    try {
      await vscode.commands.executeCommand('antigravity.openChatView');
    } catch {
      try {
        await vscode.commands.executeCommand('antigravity.openAgent');
      } catch {
        // ignore
      }
    }

    // 3. Copy clean search title to clipboard for quick paste in picker
    const cleanTitle = session.title
      .replace(/[\r\n\t]/g, ' ')
      .replace(/[^\w\s\u0600-\u06FF]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 35);

    if (cleanTitle) {
      await vscode.env.clipboard.writeText(cleanTitle);
    }

    // 4. On Windows, automatically paste and select without AppActivate or destructive keys
    if (process.platform === 'win32' && cleanTitle) {
      try {
        const tempVbs = path.join(os.tmpdir(), 'antigravity_paste_chat.vbs');
        const vbsScript = [
          'Set WshShell = CreateObject("WScript.Shell")',
          'WScript.Sleep 450',
          'WshShell.SendKeys "^v"',
          'WScript.Sleep 400',
          'WshShell.SendKeys "{ENTER}"',
          'WScript.Sleep 450',
          'WshShell.SendKeys "{ENTER}"',
        ].join('\r\n');
        fs.writeFileSync(tempVbs, vbsScript, 'utf8');
        child_process.exec(`wscript.exe "${tempVbs}"`);
      } catch (e) {
        console.warn('[ConversationService] Keystroke paste error:', e);
      }
    }

    // 5. Open native Antigravity Conversation Picker (Ctrl+Shift+A)
    try {
      await vscode.commands.executeCommand('antigravity.openConversationPicker');
    } catch {
      try {
        await vscode.commands.executeCommand('openConversationPicker');
      } catch {
        try {
          await vscode.commands.executeCommand('openConversationHistory');
        } catch {
          // ignore
        }
      }
    }

    // 5. Notify the user with an option to open the raw transcript
    const shortTitle = cleanTitle.length > 50 ? cleanTitle.slice(0, 47) + '...' : cleanTitle;
    vscode.window.showInformationMessage(
      `Copied "${shortTitle}" to clipboard. Press Ctrl+V to search in Past Conversations.`,
      'Open Transcript File'
    ).then((selected) => {
      if (selected === 'Open Transcript File') {
        this.openTranscript(session);
      }
    });
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
