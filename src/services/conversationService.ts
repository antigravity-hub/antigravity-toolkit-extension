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

  private trajectoryMap: Map<string, { title: string; workspace?: string; workspaceFullPath?: string; updatedAt?: number }> = new Map();
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
      path.join(homeDir, '.gemini', 'antigravity-ide', 'brain'),
      path.join(homeDir, '.gemini', 'antigravity', 'brain'),
      path.join(homeDir, '.gemini', 'brain'),
    ];

    // Check workspace root folders
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        dirs.push(path.join(folder.uri.fsPath, '.gemini', 'antigravity-ide', 'brain'));
        dirs.push(path.join(folder.uri.fsPath, '.gemini', 'antigravity', 'brain'));
        dirs.push(path.join(folder.uri.fsPath, '.gemini', 'brain'));
      }
    }

    const seen = new Set<string>();
    return dirs.filter((d) => {
      const norm = path.normalize(d).toLowerCase();
      if (seen.has(norm)) return false;
      seen.add(norm);
      return fs.existsSync(d);
    });
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
  /**
   * Helper to decode Protobuf varint from Buffer
   */
  private parseVarint(data: Buffer, offset: number): [number, number] {
    let res = 0;
    let shift = 0;
    while (offset < data.length) {
      const b = data[offset++];
      res |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return [res, offset];
  }

  /**
   * Helper to decode generic Protobuf fields
   */
  private parseProto(data: Buffer): Array<{ fieldNum: number; type: string; val: any }> {
    let offset = 0;
    const fields: Array<{ fieldNum: number; type: string; val: any }> = [];
    while (offset < data.length) {
      const [tag, newOffset] = this.parseVarint(data, offset);
      if (newOffset === offset) break;
      offset = newOffset;
      const wireType = tag & 7;
      const fieldNum = tag >> 3;
      if (wireType === 0) {
        let val: number;
        [val, offset] = this.parseVarint(data, offset);
        fields.push({ fieldNum, type: 'varint', val });
      } else if (wireType === 2) {
        let len: number;
        [len, offset] = this.parseVarint(data, offset);
        const val = data.slice(offset, offset + len);
        offset += len;
        fields.push({ fieldNum, type: 'bytes', val });
      } else if (wireType === 1) {
        const val = data.slice(offset, offset + 8);
        offset += 8;
        fields.push({ fieldNum, type: '64bit', val });
      } else if (wireType === 5) {
        const val = data.slice(offset, offset + 4);
        offset += 4;
        fields.push({ fieldNum, type: '32bit', val });
      } else {
        break;
      }
    }
    return fields;
  }

  /**
   * Loads official conversation titles and workspaces from state.vscdb
   * (antigravityUnifiedStateSync.trajectorySummaries) with zero lag via pure Protobuf parser.
   */
  private loadTrajectorySummaries(): void {
    const now = Date.now();
    if (this.trajectoryMap.size > 0 && now - this.lastTrajectoryLoad < 30000) {
      return;
    }

    try {
      const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : '');
      const possibleDbs = [
        path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
        path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      ];

      for (const dbPath of possibleDbs) {
        if (!fs.existsSync(dbPath)) continue;

        try {
          const val = child_process
            .execSync(
              `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';"`,
              { maxBuffer: 50 * 1024 * 1024, timeout: 7000, windowsHide: true }
            )
            .toString()
            .trim();

          if (!val) continue;

          const buf = Buffer.from(val, 'base64');
          const topFields = this.parseProto(buf);

          for (const f of topFields) {
            if (f.fieldNum !== 1 || f.type !== 'bytes') continue;
            const sub = this.parseProto(f.val);
            let uuid = '';
            let b64Payload: Buffer | null = null;
            for (const s of sub) {
              if (s.fieldNum === 1 && s.type === 'bytes') {
                uuid = s.val.toString('utf8');
              } else if (s.fieldNum === 2 && s.type === 'bytes') {
                b64Payload = s.val;
              }
            }

            if (uuid && b64Payload && !this.trajectoryMap.has(uuid)) {
              try {
                const innerBuf = Buffer.from(b64Payload.toString('utf8'), 'base64');
                const innerFields = this.parseProto(innerBuf);
                let title = '';
                let workspace = '';
                let workspaceFullPath = '';
                let protoTime = 0;

                for (const inf of innerFields) {
                  if (inf.fieldNum === 1 && inf.type === 'bytes') {
                    title = inf.val.toString('utf8');
                  } else if (inf.fieldNum === 2 && inf.type === 'varint') {
                    protoTime = inf.val;
                  } else if (inf.fieldNum === 9 && inf.type === 'bytes') {
                    const wFields = this.parseProto(inf.val);
                    for (const wf of wFields) {
                      if (wf.type === 'bytes') {
                        const str = wf.val.toString('utf8');
                        const match = str.match(/file:\/\/\/([^\s\x00-\x1f"']+)/);
                        if (match) {
                          const raw = decodeURIComponent(match[0]);
                          const clean = raw.replace(/^file:\/\/\/?/, '').replace(/^([a-zA-Z])%3A/i, '$1:');
                          const norm = path.normalize(clean);
                          workspaceFullPath = norm;
                          workspace = path.basename(norm);
                        }
                      }
                    }
                  }
                }

                if (title && title.length > 1) {
                  const updatedAt = protoTime > 100000000000 ? protoTime : protoTime > 0 ? protoTime * 1000 : undefined;
                  this.trajectoryMap.set(uuid, { title, workspace, workspaceFullPath, updatedAt });
                }
              } catch {
                // ignore item parse error
              }
            }
          }
        } catch {
          // ignore single db error
        }
      }
      this.lastTrajectoryLoad = now;
    } catch (e) {
      console.warn('[ConversationService] Failed to load trajectory summaries:', e);
    }

  }

  /**
   * Sanitizes any raw title, prompt, or plan header into a clean, concise, human-readable title.
   * Eliminates markdown tokens, XML tags, multiple lines, and truncates neatly at word boundaries.
   */
  private sanitizeTitle(raw: string, maxLength = 52): string {
    if (!raw) return '';
    let cleaned = raw
      .replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i, '$1')
      .replace(/<[A-Z_]+>[\s\S]*?<\/[A-Z_]+>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^#+\s*/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    cleaned = cleaned
      .replace(/^(?:task|original_task|implementation plan|goal|plan)[:\-–—\s]+/i, '')
      .trim();

    if (!cleaned) return '';

    const sentenceEnd = cleaned.search(/[.?!؟]\s/);
    if (sentenceEnd > 15 && sentenceEnd < maxLength) {
      cleaned = cleaned.slice(0, sentenceEnd).trim();
    }

    if (cleaned.length > maxLength) {
      const truncated = cleaned.slice(0, maxLength);
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > 20) {
        cleaned = truncated.slice(0, lastSpace).trim() + '...';
      } else {
        cleaned = truncated.trim() + '...';
      }
    }

    return cleaned;
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
        lower.startsWith('you are') ||
        lower.startsWith('use a very large team') ||
        lower.startsWith('use a team') ||
        lower.includes('team of ') ||
        lower.includes('teamwork_preview') ||
        lower.includes('project orchestrator') ||
        lower.includes('orchestrator') ||
        lower.includes('explorer_') ||
        lower.includes('reviewer_') ||
        lower.includes('auditor_') ||
        lower.includes('challenger_') ||
        lower.includes('worker_') ||
        lower.includes('spec_miner') ||
        lower.includes('explorer survey') ||
        lower.includes('victory auditor') ||
        lower.includes('acceptance gate') ||
        lower.includes('regression verification') ||
        lower.includes('working directory:') ||
        lower.includes('<original_task>') ||
        lower.includes('stop all agents') ||
        lower.includes('stop alla gents') ||
        lower.includes('independent code review') ||
        lower.includes('forensic auditor') ||
        lower.includes('adversarial stress') ||
        lower.includes('comprehensive extraction, nlp-driven')
      );
    };

    // 1. PRIMARY & AUTHORITATIVE SOURCE: Official Antigravity IDE Trajectories
    // Loads exclusively the genuine conversations registered by the IDE itself!
    for (const [convId, traj] of this.trajectoryMap.entries()) {
      seenIds.add(convId);

      // Locate transcript across brain directories
      let transcriptPath = '';
      let stepCount = 0;
      let tokenEstimate = 0;
      let mtime = traj.updatedAt || 0;
      let previewText = '';

      for (const bDir of brainDirs) {
        const compact = path.join(bDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        const full = path.join(bDir, convId, '.system_generated', 'logs', 'transcript_full.jsonl');
        const tPath = fs.existsSync(compact) ? compact : fs.existsSync(full) ? full : '';
        if (tPath) {
          transcriptPath = tPath;
          try {
            const stat = fs.statSync(tPath);
            mtime = Math.max(mtime, stat.mtimeMs);
            const content = fs.readFileSync(tPath, 'utf8');
            const lines = content.split('\n').filter((l) => l.trim().length > 0);
            stepCount = lines.length;
            tokenEstimate = Math.round(content.length / 3.8);

            // Extract preview text from early user input
            for (const line of lines.slice(0, 25)) {
              try {
                const obj = JSON.parse(line);
                if (obj.type === 'USER_INPUT' && obj.content) {
                  let raw = String(obj.content);
                  const reqMatch = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
                  if (reqMatch && reqMatch[1]) raw = reqMatch[1];
                  previewText = raw.replace(/<[^>]+>/g, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 90);
                  break;
                }
              } catch {}
            }
          } catch {}
          break;
        }
      }

      // Check implementation plan title for clean descriptive goals
      let planTitle = '';
      for (const bDir of brainDirs) {
        const planFile = path.join(bDir, convId, 'implementation_plan.md');
        if (fs.existsSync(planFile)) {
          try {
            const head = fs.readFileSync(planFile, 'utf8').split('\n')[0] || '';
            if (head.startsWith('#')) planTitle = this.sanitizeTitle(head);
          } catch {}
          break;
        }
      }

      // Sanitize title
      let finalTitle = this.sanitizeTitle(traj.title);
      if (finalTitle.includes('?') || finalTitle.includes('؟') || finalTitle.length > 48) {
        if (planTitle) finalTitle = planTitle;
      }
      if (!finalTitle) {
        finalTitle = planTitle || (previewText ? this.sanitizeTitle(previewText) : `Session ${convId.slice(0, 8)}`);
      }

      // Filter if somehow a subagent task was in trajectory
      if (isSubagentText(finalTitle) || isSubagentText(traj.title) || isSubagentText(previewText)) {
        continue;
      }

      let projectName = traj.workspace || 'General';
      let workspacePath = traj.workspaceFullPath;
      if (!workspacePath && traj.workspace && pathMap.has(traj.workspace.toLowerCase())) {
        workspacePath = pathMap.get(traj.workspace.toLowerCase());
      }
      if (!workspacePath && projectName !== 'General' && pathMap.has(projectName.toLowerCase())) {
        workspacePath = pathMap.get(projectName.toLowerCase());
      }

      const date = new Date(mtime || Date.now());
      const dateFormatted = date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      sessions.push({
        id: convId,
        title: finalTitle,
        createdAt: mtime || Date.now(),
        updatedAt: mtime || Date.now(),
        dateFormatted,
        transcriptPath,
        stepCount,
        previewText,
        projectName,
        workspacePath,
        tokenEstimate: tokenEstimate || stepCount * 1400,
      });
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
   * Automates pasting the conversation title, moving down to select, and pressing Enter in the picker.
   * Lightweight native Windows GUI script host with fast, calibrated pauses.
   */
  public automatePasteAndSelect(title: string): void {
    if (process.platform === 'win32') {
      try {
        const tempVbs = path.join(os.tmpdir(), `ag_select_${Date.now()}.vbs`);
        // Fast, reliable step-by-step automation:
        // 1. Wait 500ms for the native picker UI and search input to render.
        // 2. Send Ctrl+V and Shift+Insert to paste the title into the search box.
        // 3. Wait 900ms for fuzzy search filtering.
        // 4. Send Down Arrow to highlight the top filtered conversation.
        // 5. Wait 500ms.
        // 6. Send Enter to select and open the conversation.
        const vbsContent = [
          'Set WshShell = CreateObject("WScript.Shell")',
          'WScript.Sleep 500',
          'WshShell.SendKeys "^a"',
          'WScript.Sleep 50',
          'WshShell.SendKeys "^v"',
          'WScript.Sleep 50',
          'WshShell.SendKeys "+{INSERT}"',
          'WScript.Sleep 900',
          'WshShell.SendKeys "{DOWN}"',
          'WScript.Sleep 500',
          'WshShell.SendKeys "{ENTER}"',
          'WScript.Sleep 200',
          'WshShell.SendKeys "{ENTER}"',
          'WScript.Sleep 300',
        ].join('\r\n');
        fs.writeFileSync(tempVbs, vbsContent, 'utf8');

        const proc = child_process.spawn('wscript.exe', ['//Nologo', tempVbs], {
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
        }, 10000);
      } catch (err) {
        console.warn('[ConversationService] Windows SendKeys automation error:', err);
      }
    } else if (process.platform === 'darwin') {
      try {
        const script =
          'delay 0.5\ntell application "System Events" to keystroke "v" using command down\ndelay 0.9\ntell application "System Events" to key code 125\ndelay 0.5\ntell application "System Events" to key code 36\ndelay 0.2\ntell application "System Events" to key code 36';
        child_process.exec(`osascript -e '${script}'`);
      } catch {
        // ignore
      }
    } else {
      try {
        child_process.exec(
          'sleep 0.5 && xdotool key ctrl+v && sleep 0.9 && xdotool key Down && sleep 0.5 && xdotool key Return && sleep 0.2 && xdotool key Return'
        );
      } catch {
        // ignore
      }
    }
  }

  /**
   * Opens the conversation session in Antigravity IDE:
   * 1. If it belongs to a different project workspace, prompts smoothly to switch.
   * 2. Copies the session title to the clipboard.
   * 3. Launches Antigravity's native Conversation Picker (antigravity.openConversationPicker).
   * 4. Automatically executes: Paste -> wait -> Down Arrow -> wait -> Enter.
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

          // Copy search query to clipboard
          const searchQuery = cleanTitle
            .replace(/\.{3,}$/, '')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 35);
          if (searchQuery) {
            await vscode.env.clipboard.writeText(searchQuery);
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

    // 2. Prepare clean search query (remove dots, ellipsis, special chars, max 35 chars for ideal QuickPick fuzzy match)
    const searchQuery = cleanTitle
      .replace(/\.{3,}$/, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 35);

    // 3. Copy search query to clipboard
    if (searchQuery) {
      await vscode.env.clipboard.writeText(searchQuery);
    }

    // 4. Launch automation concurrently in background (DO NOT AWAIT!)
    // vscode.commands.executeCommand on QuickPick blocks until the picker is closed,
    // so automation MUST run concurrently in the background!
    this.automatePasteAndSelect(searchQuery);

    // 5. Open Antigravity's native Conversation Picker (DO NOT AWAIT!)
    vscode.commands.executeCommand('antigravity.openConversationPicker').then(undefined, () => {
      vscode.commands.executeCommand('openConversationPicker').then(undefined, () => {});
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
