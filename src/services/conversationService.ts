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

    // 2. Discover from IDE workspaceStorage (Antigravity, Antigravity IDE, Cursor, Code)
    const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : '');
    if (appData) {
      const storageRoots = [
        path.join(appData, 'Antigravity', 'User', 'workspaceStorage'),
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
      const possibleDbs = [
        path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
        path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
      ];
      const dbPath = possibleDbs.find((p) => fs.existsSync(p));
      if (!dbPath) return;

      const val = child_process
        .execSync(
          `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';"`,
          { maxBuffer: 25 * 1024 * 1024, timeout: 5000, windowsHide: true }
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
          let detectedWsPath = '';
          let tokenEstimate = 0;
          let sampleContent = '';

          try {
            const content = fs.readFileSync(transcriptPath, 'utf8');
            const lines = content.split('\n').filter((l) => l.trim().length > 0);
            stepCount = lines.length;
            tokenEstimate = Math.round(content.length / 3.8);

            // 1. Accurate project detection from <user_information> block in early lines
            for (const line of lines.slice(0, 25)) {
              // Match [URI] -> [CorpusName] format
              const uriMatch =
                line.match(/(?:active workspaces[^\n]*\n|\bformat\s+\[URI\]\s*->\s*\[CorpusName\]:\s*|\b)([a-zA-Z]:[^\r\n"'>\\]+(?:\\|\/)[^\r\n"'>\\]+)\s*->/i) ||
                line.match(/The user has \d+ active workspaces.*?([a-zA-Z]:[^\r\n"'>]+?)\s*->/i);
              if (uriMatch && uriMatch[1]) {
                const cand = uriMatch[1].trim();
                const norm = path.normalize(cand);
                if (fs.existsSync(norm)) {
                  detectedWsPath = norm;
                  projectName = path.basename(norm);
                  if (!pathMap.has(projectName.toLowerCase())) {
                    pathMap.set(projectName.toLowerCase(), norm);
                  }
                  break;
                }
              }

              // Check working directory: <path>
              const wdMatch = line.match(/working directory:\s*([a-zA-Z]:[^\r\n"']+)/i);
              if (wdMatch && wdMatch[1]) {
                const cand = wdMatch[1].trim();
                const norm = path.normalize(cand);
                for (const [kwLower, kwPath] of pathMap.entries()) {
                  if (norm.toLowerCase().startsWith(kwPath.toLowerCase())) {
                    detectedWsPath = kwPath;
                    projectName = path.basename(kwPath);
                    break;
                  }
                }
                if (detectedWsPath) break;
              }
            }

            // 2. Inspect early tool call arguments (SearchDirectory, Cwd, DirectoryPath, TargetFile, AbsolutePath)
            if (!detectedWsPath) {
              for (const line of lines.slice(0, 40)) {
                try {
                  const obj = JSON.parse(line);
                  if (obj.tool_calls && Array.isArray(obj.tool_calls)) {
                    for (const tc of obj.tool_calls) {
                      const args = tc.args || {};
                      const cand =
                        args.SearchDirectory ||
                        args.Cwd ||
                        args.DirectoryPath ||
                        args.TargetFile ||
                        args.AbsolutePath ||
                        args.SearchPath ||
                        '';
                      if (cand && typeof cand === 'string') {
                        let cleanCand = cand.replace(/^"+|"+$/g, '').trim();
                        if (cleanCand.length > 3) {
                          const norm = path.normalize(cleanCand);
                          for (const [kwLower, kwPath] of pathMap.entries()) {
                            if (norm.toLowerCase().startsWith(kwPath.toLowerCase())) {
                              detectedWsPath = kwPath;
                              projectName = path.basename(kwPath);
                              break;
                            }
                          }
                          if (!detectedWsPath && fs.existsSync(norm)) {
                            const stat = fs.statSync(norm);
                            const dir = stat.isDirectory() ? norm : path.dirname(norm);
                            detectedWsPath = dir;
                            projectName = path.basename(dir);
                            if (!pathMap.has(projectName.toLowerCase())) {
                              pathMap.set(projectName.toLowerCase(), dir);
                            }
                            break;
                          }
                        }
                      }
                    }
                  }
                  if (detectedWsPath) break;

                  // Extract first clean user input as preview
                  if (obj.type === 'USER_INPUT' && obj.content && !previewText) {
                    let cleaned = String(obj.content)
                      .replace(/<USER_REQUEST>[\s\S]*?<\/USER_REQUEST>/g, (m) => m.replace(/<\/?USER_REQUEST>/g, ''))
                      .replace(/<[^>]+>/g, '')
                      .replace(/\r?\n+/g, ' ')
                      .trim();
                    if (cleaned.length > 0) {
                      previewText = cleaned.slice(0, 90);
                    }
                  }
                } catch {
                  // ignore
                }
              }
            }

            // 3. Fallback: check file URI patterns in early lines
            if (!detectedWsPath) {
              for (const line of lines.slice(0, 30)) {
                const fileMatch = line.match(/file:\/\/\/([a-zA-Z]:\/[^\s"'>\\]+)/i);
                if (fileMatch) {
                  const cleanUri = decodeURIComponent(fileMatch[1]).replace(/\//g, path.sep);
                  const normUri = path.normalize(cleanUri);
                  for (const [kwLower, kwPath] of pathMap.entries()) {
                    if (normUri.toLowerCase().startsWith(kwPath.toLowerCase())) {
                      detectedWsPath = kwPath;
                      projectName = path.basename(kwPath);
                      break;
                    }
                  }
                  if (detectedWsPath) break;
                }
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
            if (!detectedWsPath && pathMap.has(traj.workspace.toLowerCase())) {
              detectedWsPath = pathMap.get(traj.workspace.toLowerCase())!;
            }
          }

          if (stepCount === 0 && !finalTitle) {
            continue;
          }

          // Filter out subagents and background worker tasks
          if (isSubagentText(finalTitle) || isSubagentText(previewText)) {
            continue;
          }

          seenIds.add(convId);

          let workspacePath: string | undefined = detectedWsPath;
          if (!workspacePath && projectName) {
            workspacePath = pathMap.get(projectName.toLowerCase());
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
            projectName: projectName || 'General',
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
   * Returns conversations strictly filtered to the currently active IDE workspace.
   */
  public async getActiveWorkspaceConversations(forceRefresh = false): Promise<ConversationSession[]> {
    const all = await this.getConversations(forceRefresh);
    const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!currentFolder) {
      return all;
    }
    const normCurrent = path.normalize(currentFolder).toLowerCase();
    const currentName = (vscode.workspace.name || path.basename(currentFolder)).toLowerCase();

    return all.filter((s) => {
      if (s.workspacePath) {
        const normWs = path.normalize(s.workspacePath).toLowerCase();
        if (
          normWs === normCurrent ||
          normWs.startsWith(normCurrent + path.sep) ||
          normCurrent.startsWith(normWs + path.sep)
        ) {
          return true;
        }
      }
      if (s.projectName && s.projectName.toLowerCase() === currentName) {
        return true;
      }
      return false;
    });
  }

  /**
   * Automates pasting the conversation title and pressing Enter in the native picker.
   * Zero manual intervention, lightweight, non-intrusive SendKeys automation.
   */
  public automatePasteAndSelect(title: string): void {
    if (process.platform === 'win32') {
      try {
        const tempVbs = path.join(os.tmpdir(), `ag_paste_${Date.now()}.vbs`);
        const vbsContent = [
          'Set WshShell = CreateObject("WScript.Shell")',
          'WScript.Sleep 160',
          'WshShell.SendKeys "^v"',
          'WScript.Sleep 200',
          'WshShell.SendKeys "{ENTER}"',
        ].join('\r\n');
        fs.writeFileSync(tempVbs, vbsContent, 'utf8');

        const proc = child_process.spawn('cscript.exe', ['//Nologo', tempVbs], {
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
        });
        proc.unref();

        setTimeout(() => {
          try {
            if (fs.existsSync(tempVbs)) fs.unlinkSync(tempVbs);
          } catch {
            // ignore
          }
        }, 4000);
      } catch (err) {
        console.warn('[ConversationService] Windows SendKeys automation error:', err);
      }
    } else if (process.platform === 'darwin') {
      try {
        const script =
          'tell application "System Events" to keystroke "v" using command down\ndelay 0.2\ntell application "System Events" to key code 36';
        child_process.exec(`osascript -e '${script}'`);
      } catch {
        // ignore
      }
    } else {
      try {
        child_process.exec('xdotool key ctrl+v Return');
      } catch {
        // ignore
      }
    }
  }

  /**
   * Opens the conversation session in Antigravity IDE:
   * 1. If it belongs to a different project workspace, prompts smoothly to switch.
   * 2. Focuses/opens the Antigravity Chat panel.
   * 3. Copies the session title to the clipboard for fast filtering.
   * 4. Opens Antigravity's native Conversation Picker (Ctrl+Shift+A).
   * 5. Automatically pastes title and selects the conversation with zero manual prompt.
   */
  public async openConversation(session: ConversationSession): Promise<void> {
    const cleanTitle = session.title.replace(/[\r\n\t]+/g, ' ').trim();

    // 1. If conversation belongs to another project, ask user or switch smoothly
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
          'Open/Switch to Workspace',
          'Open in Current Window',
          'View Transcript File'
        );
        if (choice === 'Open/Switch to Workspace') {
          // Store pending conversation state for the destination window
          try {
            const pendingFile = path.join(os.homedir(), '.gemini', 'pending_open_chat.json');
            fs.writeFileSync(
              pendingFile,
              JSON.stringify({
                sessionId: session.id,
                title: session.title,
                workspacePath: session.workspacePath,
                timestamp: Date.now(),
              }),
              'utf8'
            );
          } catch {
            // ignore
          }

          // Copy title to clipboard
          if (cleanTitle) {
            await vscode.env.clipboard.writeText(cleanTitle);
          }

          // Switch or open folder without forcing a duplicate blank window
          const targetUri = vscode.Uri.file(session.workspacePath);
          await vscode.commands.executeCommand('vscode.openFolder', targetUri, { forceNewWindow: false });
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

    // 3. Copy verbatim title to clipboard (preserving Persian ZWNJ, full text, and symbols)
    if (cleanTitle) {
      await vscode.env.clipboard.writeText(cleanTitle);
    }

    // 4. Open native Antigravity Conversation Picker (Ctrl+Shift+A)
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

    // 5. Automated paste and select (100% automated, no manual prompt)
    this.automatePasteAndSelect(cleanTitle);
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
