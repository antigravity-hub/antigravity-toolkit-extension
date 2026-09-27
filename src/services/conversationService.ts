import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import * as util from 'util';
import { ConversationSession, ConversationStep, ContentSearchResult, ContentSearchSnippet } from '../types';

export class ConversationService {
  private static instance: ConversationService;
  private onDidChangeConversationsEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeConversations = this.onDidChangeConversationsEmitter.event;

  private trajectoryMap: Map<string, { title: string; workspace?: string; workspaceFullPath?: string; updatedAt?: number }> = new Map();
  private lastTrajectoryLoad = 0;
  private cachedSessions: ConversationSession[] = [];
  private lastSessionsScan = 0;
  private officialTitleCache: Map<string, string> = new Map();
  private brainWatchers: fs.FSWatcher[] = [];
  private watchDebounceTimer: NodeJS.Timeout | undefined;
  private isSelfWritingDb = false;

  private constructor() {}

  public static getInstance(): ConversationService {
    if (!ConversationService.instance) {
      ConversationService.instance = new ConversationService();
    }
    return ConversationService.instance;
  }

  public getCachedSessions(): ConversationSession[] {
    return this.cachedSessions;
  }

  /**
   * Initializes real-time file system watchers on the brain storage directories.
   * Ensures that whenever a conversation is started, updated, or an IDE crash/power-loss occurs,
   * the conversations list is immediately updated live without requiring an IDE reload.
   */
  public initWatchers(): void {
    this.disposeWatchers();
    const brainDirs = this.getBrainDirectories();
    for (const bDir of brainDirs) {
      if (!fs.existsSync(bDir)) continue;
      try {
        const watcher = fs.watch(bDir, { recursive: true }, () => {
          this.scheduleWatchRefresh();
        });
        this.brainWatchers.push(watcher);
      } catch {
        try {
          const watcher = fs.watch(bDir, { recursive: false }, () => {
            this.scheduleWatchRefresh();
          });
          this.brainWatchers.push(watcher);
        } catch {
          // ignore filesystem watch limitations
        }
      }
    }

    // Watch Antigravity conversations database directory (~/.gemini/antigravity-ide/conversations)
    const homeDir = os.homedir();
    const convDirs = [
      path.join(homeDir, '.gemini', 'antigravity-ide', 'conversations'),
      path.join(homeDir, '.gemini', 'antigravity', 'conversations'),
      path.join(homeDir, '.gemini', 'conversations'),
    ];
    for (const cDir of convDirs) {
      if (fs.existsSync(cDir)) {
        try {
          const w = fs.watch(cDir, { recursive: false }, () => {
            this.scheduleWatchRefresh();
          });
          this.brainWatchers.push(w);
        } catch {}
      }
    }

    // Watch globalStorage state.vscdb directory (guarded against self-mutations)
    const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : '');
    if (appData) {
      const gsDirs = [
        path.join(appData, 'Antigravity IDE', 'User', 'globalStorage'),
        path.join(appData, 'Antigravity', 'User', 'globalStorage'),
      ];
      for (const gsDir of gsDirs) {
        if (fs.existsSync(gsDir)) {
          try {
            const w = fs.watch(gsDir, { recursive: false }, (_event, filename) => {
              if (this.isSelfWritingDb) return;
              if (!filename || filename.toLowerCase().includes('state.vscdb')) {
                this.scheduleWatchRefresh();
              }
            });
            this.brainWatchers.push(w);
          } catch {}
        }
      }
    }
  }

  private scheduleWatchRefresh(): void {
    if (this.isSelfWritingDb) return;
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
    }
    this.watchDebounceTimer = setTimeout(() => {
      if (this.isSelfWritingDb) return;
      this.lastSessionsScan = 0;
      this.lastTrajectoryLoad = 0;
      this.refresh();
    }, 2000);
  }

  public disposeWatchers(): void {
    for (const w of this.brainWatchers) {
      try {
        w.close();
      } catch {}
    }
    this.brainWatchers = [];
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = undefined;
    }
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
      if (!pathMap.has(p.toLowerCase())) {
        const parentBase = 'd:\\Ershad Zolfi\\programming\\coding with Gemini';
        const cand = path.join(parentBase, p);
        if (fs.existsSync(cand)) {
          pathMap.set(p.toLowerCase(), cand);
        }
      }
    }

    const sortedNames = Array.from(names).sort((a, b) => b.length - a.length);
    return { names: sortedNames, pathMap };
  }

  /**
   * Loads official conversation titles and workspaces from state.vscdb
   * (antigravityUnifiedStateSync.trajectorySummaries) with zero lag.
   */
  /**
   * Helper to decode Protobuf varint from Buffer without 32-bit overflow
   */
  private parseVarint(data: Buffer, offset: number): [number, number] {
    let res = 0;
    let shift = 0;
    while (offset < data.length) {
      const b = data[offset++];
      res += (b & 0x7f) * Math.pow(2, shift);
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
   * Encodes an unsigned integer into a Protobuf varint Buffer.
   */
  private encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    while (value > 0x7f) {
      bytes.push((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    bytes.push(value & 0x7f);
    return Buffer.from(bytes);
  }

  private encodeTag(fieldNum: number, wireType: number): Buffer {
    return this.encodeVarint((fieldNum << 3) | wireType);
  }

  private encodeBytesField(fieldNum: number, data: Buffer | string): Buffer {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const tag = this.encodeTag(fieldNum, 2);
    const len = this.encodeVarint(buf.length);
    return Buffer.concat([tag, len, buf]);
  }

  private encodeVarintField(fieldNum: number, val: number): Buffer {
    const tag = this.encodeTag(fieldNum, 0);
    const v = this.encodeVarint(val);
    return Buffer.concat([tag, v]);
  }

  private encodeTimestampField(fieldNum: number, tsMs: number): Buffer {
    const sec = Math.floor(tsMs / 1000);
    const nanos = Math.floor((tsMs % 1000) * 1_000_000);
    const f1 = this.encodeVarintField(1, sec);
    const f2 = this.encodeVarintField(2, nanos);
    return this.encodeBytesField(fieldNum, Buffer.concat([f1, f2]));
  }

  private serializeCascadeSummary(uuidStr: string, title: string, workspaceUri: string, tsMs: number): Buffer {
    const f1 = this.encodeBytesField(1, title);
    const f2 = this.encodeVarintField(2, 1);
    const f3 = this.encodeTimestampField(3, tsMs);
    const f7 = this.encodeTimestampField(7, tsMs);
    const wsBuf = workspaceUri
      ? Buffer.concat([this.encodeBytesField(1, workspaceUri), this.encodeBytesField(2, workspaceUri)])
      : Buffer.alloc(0);
    const f9 = wsBuf.length > 0 ? this.encodeBytesField(9, wsBuf) : Buffer.alloc(0);
    const f10 = this.encodeTimestampField(10, tsMs);
    const f17Sub = this.encodeBytesField(6, uuidStr);
    const f17 = this.encodeBytesField(17, f17Sub);
    return Buffer.concat([f1, f2, f3, f7, f9, f10, f17]);
  }

  private serializeTrajectoryEntry(uuidStr: string, summaryBytes: Buffer): Buffer {
    const b64Val = summaryBytes.toString('base64');
    const newRow = this.encodeBytesField(1, b64Val);
    const entryMsg = Buffer.concat([this.encodeBytesField(1, uuidStr), this.encodeBytesField(2, newRow)]);
    return this.encodeBytesField(1, entryMsg);
  }

  /**
   * Autonomously injects an unindexed or crash-interrupted conversation into state.vscdb
   * (antigravityUnifiedStateSync.trajectorySummaries) so that Antigravity IDE natively recognizes it.
   */
  public injectTrajectorySummary(sessionId: string, title: string, workspacePath = ''): boolean {
    if (!sessionId || this.isPlaceholderTitle(title)) return false;
    this.isSelfWritingDb = true;
    try {
      const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : '');
      const ideDbPath = path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
      const fallbackDbPath = path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
      const dbPath = fs.existsSync(ideDbPath) ? ideDbPath : fs.existsSync(fallbackDbPath) ? fallbackDbPath : '';
      if (!dbPath) return false;

      // 1. Fetch current value
      const querySql = "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';\n";
      const qRes = child_process.spawnSync('sqlite3', [dbPath], {
        input: querySql,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 3000,
      });

      const currentVal = (qRes.stdout || '').trim();
      const currentBuf = currentVal ? Buffer.from(currentVal, 'base64') : Buffer.alloc(0);

      let filteredBuf = currentBuf;
      // If session ID already exists in database, filter out the old entry so we can replace it with the new real title
      if (currentBuf.includes(Buffer.from(sessionId, 'utf8'))) {
        try {
          const top = this.parseProto(currentBuf);
          const filteredEntries: Buffer[] = [];
          for (const f of top) {
            if (f.fieldNum !== 1 || f.type !== 'bytes') continue;
            const sub = this.parseProto(f.val);
            let existingUuid = '';
            for (const s of sub) {
              if (s.fieldNum === 1 && s.type === 'bytes') {
                existingUuid = s.val.toString('utf8');
              }
            }
            if (existingUuid !== sessionId) {
              filteredEntries.push(this.encodeBytesField(1, f.val));
            }
          }
          filteredBuf = Buffer.concat(filteredEntries);
        } catch {
          filteredBuf = currentBuf;
        }
      }

      // Convert workspacePath to file URI if provided
      let wsUri = '';
      if (workspacePath) {
        let norm = workspacePath.replace(/\\/g, '/');
        if (!norm.startsWith('/')) norm = '/' + norm;
        wsUri = `file://${encodeURI(norm)}`;
      }

      const summaryBytes = this.serializeCascadeSummary(sessionId, title, wsUri, Date.now());
      const newEntry = this.serializeTrajectoryEntry(sessionId, summaryBytes);

      const mergedBuf = Buffer.concat([newEntry, filteredBuf]);
      const mergedB64 = mergedBuf.toString('base64');

      const updateSql = `UPDATE ItemTable SET value = '${mergedB64}' WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';\n`;
      const uRes = child_process.spawnSync('sqlite3', [dbPath], {
        input: updateSql,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 3000,
      });

      if (uRes.status === 0) {
        this.trajectoryMap.set(sessionId, {
          title,
          workspace: workspacePath ? path.basename(workspacePath) : undefined,
          workspaceFullPath: workspacePath || undefined,
          updatedAt: Date.now(),
        });
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[ConversationService] Failed to inject trajectory summary:', err);
      return false;
    } finally {
      setTimeout(() => {
        this.isSelfWritingDb = false;
      }, 1500);
    }
  }

  /**
   * Loads official conversation titles and workspaces from state.vscdb
   * (antigravityUnifiedStateSync.trajectorySummaries) with zero lag via pure Protobuf parser.
   * Authoritative source: Antigravity IDE database only.
   */
  private loadTrajectorySummaries(force = false): void {
    const now = Date.now();
    if (!force && this.trajectoryMap.size > 0 && now - this.lastTrajectoryLoad < 30000) {
      return;
    }
    this.trajectoryMap.clear();

    try {
      const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : '');
      const ideDbPath = path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
      const fallbackDbPath = path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
      const dbPath = fs.existsSync(ideDbPath) ? ideDbPath : fs.existsSync(fallbackDbPath) ? fallbackDbPath : '';

      if (!dbPath) {
        return;
      }

      try {
        const val = child_process
          .execSync(
            `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';"`,
            { maxBuffer: 50 * 1024 * 1024, timeout: 7000, windowsHide: true }
          )
          .toString()
          .trim();

        if (!val) return;

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
              let protoTimestamp = 0;

              for (const inf of innerFields) {
                if (inf.fieldNum === 1 && inf.type === 'bytes') {
                  title = inf.val.toString('utf8');
                } else if (inf.fieldNum === 7 && inf.type === 'bytes') {
                  // Protobuf Timestamp: subfield 1 is varint seconds
                  const tFields = this.parseProto(inf.val);
                  for (const tf of tFields) {
                    if (tf.fieldNum === 1 && tf.type === 'varint') {
                      protoTimestamp = tf.val * 1000;
                    }
                  }
                } else if (inf.fieldNum === 3 && inf.type === 'bytes' && !protoTimestamp) {
                  // Fallback Created At
                  const tFields = this.parseProto(inf.val);
                  for (const tf of tFields) {
                    if (tf.fieldNum === 1 && tf.type === 'varint') {
                      protoTimestamp = tf.val * 1000;
                    }
                  }
                } else if (inf.fieldNum === 9 && inf.type === 'bytes') {
                  // Workspace sub-message
                  const wFields = this.parseProto(inf.val);
                  for (const wf of wFields) {
                    if ((wf.fieldNum === 1 || wf.fieldNum === 2) && wf.type === 'bytes') {
                      const rawStr = wf.val.toString('utf8');
                      if (rawStr.startsWith('file:///')) {
                        try {
                          const dec = decodeURIComponent(rawStr);
                          const clean = dec.replace(/^file:\/\/\/?/, '').replace(/^([a-zA-Z])%3A/i, '$1:');
                          const norm = path.normalize(clean);
                          workspaceFullPath = norm;
                          workspace = path.basename(norm);
                          break;
                        } catch {}
                      }
                    }
                  }
                }
              }

              if (title && title.length > 1) {
                const updatedAt = protoTimestamp || undefined;
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
      this.lastTrajectoryLoad = now;
    } catch (e) {
      console.warn('[ConversationService] Failed to load trajectory summaries:', e);
    }

  }

  /**
   * Sanitizes any raw title, prompt, or plan header into a clean, concise, human-readable title.
   * Eliminates markdown tokens, XML tags, slash commands, multiple lines, and truncates neatly at word boundaries.
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
      .replace(/^\/(?:plan|goal|schedule|grill-me|learn|task)\s+/i, '')
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
   * Checks if a title is a dummy/placeholder title rather than a genuine human or AI-summarized topic.
   */
  private isPlaceholderTitle(title: string | undefined): boolean {
    if (!title) return true;
    const t = title.trim();
    return (
      /^Session\s+[0-9a-f]{6,12}$/i.test(t) ||
      /^[0-9a-f]{12,64}$/i.test(t) ||
      t.toLowerCase() === 'empty conversation thread' ||
      t.toLowerCase() === 'new chat' ||
      t.toLowerCase() === 'untitled'
    );
  }

  /**
   * Fast synchronous extractor from in-memory cache and *.pbtxt annotations (<0.05ms)
   */
  public extractAnnotationTitle(convId: string): string | null {
    if (!convId) return null;
    if (this.officialTitleCache.has(convId)) {
      return this.officialTitleCache.get(convId)!;
    }

    const homeDir = os.homedir();
    const annotationDirs = [
      path.join(homeDir, '.gemini', 'antigravity', 'annotations'),
      path.join(homeDir, '.gemini', 'antigravity-ide', 'annotations'),
      path.join(homeDir, '.gemini', 'antigravity-cli', 'annotations'),
    ];
    for (const ad of annotationDirs) {
      const p = path.join(ad, `${convId}.pbtxt`);
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          const match = content.match(/title:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
          if (match && match[1]) {
            const clean = match[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
            if (clean && !this.isPlaceholderTitle(clean)) {
              this.officialTitleCache.set(convId, clean);
              return clean;
            }
          }
        } catch {}
      }
    }
    return null;
  }

  /**
   * High-precision, multi-tier extractor for official conversation title from:
   * 1. In-memory cache (0ms)
   * 2. Antigravity annotations (*.pbtxt) (0.05ms)
   * 3. Antigravity conversation DB step_type = 23 (compaction/title checkpoint)
   */
  public async extractOfficialTitle(convId: string): Promise<string | null> {
    if (!convId) return null;
    const fastTitle = this.extractAnnotationTitle(convId);
    if (fastTitle) return fastTitle;

    const homeDir = os.homedir();
    const dbPaths = [
      path.join(homeDir, '.gemini', 'antigravity-ide', 'conversations', `${convId}.db`),
      path.join(homeDir, '.gemini', 'antigravity', 'conversations', `${convId}.db`),
      path.join(homeDir, '.gemini', 'conversations', `${convId}.db`),
    ];
    let dbPath = '';
    for (const p of dbPaths) {
      if (fs.existsSync(p)) {
        dbPath = p;
        break;
      }
    }
    if (!dbPath) return null;

    try {
      const { stdout } = await util.promisify(child_process.execFile)(
        'sqlite3',
        [dbPath, 'SELECT CAST(step_payload AS BLOB) FROM steps WHERE step_type = 23 LIMIT 1;'],
        { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, windowsHide: true, timeout: 2500 }
      );
      const buf = stdout;
      if (buf && buf.length > 0) {
        for (let i = 0; i < buf.length - 10; i++) {
          if (buf[i] === 0x22) {
            const len = buf[i + 1];
            if (len === 36) {
              const uStr = buf.slice(i + 2, i + 2 + 36).toString('utf8');
              if (uStr.toLowerCase() === convId.toLowerCase()) {
                let j = i + 2 + 36;
                while (j < Math.min(i + 500, buf.length - 2)) {
                  if (buf[j] === 0x22) {
                    const tLen = buf[j + 1];
                    if (tLen > 0 && tLen < 200 && j + 2 + tLen <= buf.length) {
                      const title = buf.slice(j + 2, j + 2 + tLen).toString('utf8');
                      if (!title.includes('\n') && !title.includes('\r')) {
                        const clean = title.trim();
                        if (clean && !this.isPlaceholderTitle(clean)) {
                          this.officialTitleCache.set(convId, clean);
                          return clean;
                        }
                      }
                    }
                  }
                  j++;
                }
              }
            }
          }
        }
      }
    } catch {
      // ignore db read failure
    }
    return null;
  }

  /**
   * Scans brain directory for implementation_plan.md or any domain-specific *_plan.md.
   */
  private extractPlanTitle(bDir: string, convId: string): string {
    const convDir = path.join(bDir, convId);
    if (!fs.existsSync(convDir)) return '';
    try {
      // 1. Primary implementation plan
      const primaryPlan = path.join(convDir, 'implementation_plan.md');
      if (fs.existsSync(primaryPlan)) {
        const head = fs.readFileSync(primaryPlan, 'utf8').split('\n')[0] || '';
        if (head.startsWith('#')) return this.sanitizeTitle(head);
      }
      // 2. Scan other markdown plans
      const entries = fs.readdirSync(convDir);
      for (const e of entries) {
        if (e.endsWith('.md') && (e.includes('plan') || e.includes('arch') || e.includes('spec') || e.includes('design'))) {
          const p = path.join(convDir, e);
          const head = fs.readFileSync(p, 'utf8').split('\n')[0] || '';
          if (head.startsWith('#')) return this.sanitizeTitle(head);
        }
      }
    } catch {}
    return '';
  }

  /**
   * Scans and returns all discovered conversations sorted by latest activity.
   * Internal subagents, background workers, and robotic prompts are filtered out.
   */
  public async getConversations(forceRefresh = false): Promise<ConversationSession[]> {
    const now = Date.now();
    if (!forceRefresh && this.cachedSessions.length > 0 && now - this.lastSessionsScan < 30000) {
      return this.cachedSessions;
    }

    this.loadTrajectorySummaries(forceRefresh);
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
    // Loaded in < 25ms from state.vscdb protobuf with full titles & workspaces
    let recentProcessedCount = 0;
    for (const [convId, traj] of this.trajectoryMap.entries()) {
      seenIds.add(convId);

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
            stepCount = Math.round(stat.size / 400) || 1;
            tokenEstimate = Math.round(stat.size / 3.8);

            // Read fast 4KB slice only for recent conversations to extract preview without reading 50MB files
            if (recentProcessedCount < 20) {
              const fd = fs.openSync(tPath, 'r');
              const buf = Buffer.alloc(4096);
              const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
              fs.closeSync(fd);
              const chunk = buf.toString('utf8', 0, bytesRead);
              for (const line of chunk.split('\n')) {
                if (line.includes('"type":"USER_INPUT"') || line.includes('<USER_REQUEST>')) {
                  try {
                    const obj = JSON.parse(line);
                    if (obj.content) {
                      let raw = String(obj.content);
                      const reqMatch = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
                      if (reqMatch && reqMatch[1]) raw = reqMatch[1];
                      const clean = raw.replace(/<[^>]+>/g, '').replace(/[\r\n\t]+/g, ' ').trim();
                      if (clean && !isSubagentText(clean)) {
                        previewText = clean.slice(0, 90);
                        break;
                      }
                    }
                  } catch {}
                }
              }
            }
          } catch {}
          break;
        } else {
          const bFolder = path.join(bDir, convId);
          if (fs.existsSync(bFolder)) {
            try {
              const stat = fs.statSync(bFolder);
              mtime = Math.max(mtime, stat.mtimeMs);
            } catch {}
          }
        }
      }

      recentProcessedCount++;

      const trajTitle = this.sanitizeTitle(traj.title);
      let finalTitle = trajTitle;

      if (!finalTitle || this.isPlaceholderTitle(finalTitle) || finalTitle.includes('file:') || finalTitle.includes('file:///')) {
        finalTitle = previewText ? this.sanitizeTitle(previewText) : `Session ${convId.slice(0, 8)}`;
      }

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

      if (
        !projectName ||
        projectName.includes('%') ||
        projectName.includes('\n') ||
        projectName.includes('..') ||
        projectName.length > 40
      ) {
        if (workspacePath && fs.existsSync(workspacePath)) {
          projectName = path.basename(workspacePath);
        } else {
          projectName = 'General';
        }
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

    // 2. DISK FALLBACK & LIVE RECOVERY SCANNER
    // Scans brain directories directly to recover sessions that were terminated
    // abruptly (power outage, crash, sudden window close) or are actively running
    // and have not yet been flushed by the IDE into state.vscdb trajectorySummaries.
    for (const bDir of brainDirs) {
      if (!fs.existsSync(bDir)) continue;
      try {
        const entries = fs.readdirSync(bDir, { withFileTypes: true });
        const folderCandidates: { name: string; mtimeMs: number }[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const convId = entry.name;
          if (convId === 'tempmediaStorage' || convId.startsWith('.') || seenIds.has(convId)) {
            continue;
          }
          try {
            const fStat = fs.statSync(path.join(bDir, convId));
            let mtimeMs = fStat.mtimeMs;
            const compactPath = path.join(bDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
            if (fs.existsSync(compactPath)) {
              try {
                const tStat = fs.statSync(compactPath);
                mtimeMs = Math.max(mtimeMs, tStat.mtimeMs);
              } catch {}
            }
            folderCandidates.push({ name: convId, mtimeMs });
          } catch {}
        }

        folderCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

        // Process up to 250 most recent unindexed sessions
        for (const cand of folderCandidates.slice(0, 250)) {
          const convId = cand.name;
          if (seenIds.has(convId)) continue;

          const compact = path.join(bDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
          const full = path.join(bDir, convId, '.system_generated', 'logs', 'transcript_full.jsonl');
          const tPath = fs.existsSync(compact) ? compact : fs.existsSync(full) ? full : '';
          if (!tPath) continue;

          seenIds.add(convId);

          let stepCount = 0;
          let tokenEstimate = 0;
          let mtime = cand.mtimeMs;
          let previewText = '';
          let userPromptTitle = '';
          let isSubagent = false;

          try {
            const stat = fs.statSync(tPath);
            mtime = Math.max(mtime, stat.mtimeMs);
            stepCount = Math.round(stat.size / 400) || 1;
            tokenEstimate = Math.round(stat.size / 3.8);

            // Read fast 32KB slice from start to parse first 15 lines without loading multi-megabyte files
            const fd = fs.openSync(tPath, 'r');
            const headBuf = Buffer.alloc(32768);
            const bytesRead = fs.readSync(fd, headBuf, 0, 32768, 0);
            fs.closeSync(fd);
            const chunk = headBuf.toString('utf8', 0, bytesRead);
            const lines = chunk.split('\n').filter((l) => l.trim().length > 0);

            for (let i = 0; i < Math.min(lines.length, 15); i++) {
              try {
                const entry = JSON.parse(lines[i]);
                if (entry.type === 'USER_INPUT' && entry.content) {
                  const raw = entry.content;
                  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                  const cleanPrompt = match ? match[1].trim() : raw.trim();
                  if (cleanPrompt) {
                    if (isSubagentText(cleanPrompt)) {
                      isSubagent = true;
                      break;
                    }
                    if (!previewText) {
                      previewText = cleanPrompt.replace(/\s+/g, ' ').slice(0, 140);
                      userPromptTitle = cleanPrompt.replace(/[\r\n\t]+/g, ' ').trim();
                    }
                  }
                }
              } catch {}
            }

            if (isSubagent) continue;
            if (!previewText && stepCount <= 1) continue;

            // 1. Check in-memory cache and *.pbtxt annotations (fast <0.05ms)
            const officialDbTitle = this.extractAnnotationTitle(convId);
            // 2. Implementation plan title
            let planTitle = '';
            for (const d of brainDirs) {
              planTitle = this.extractPlanTitle(d, convId);
              if (planTitle) break;
            }

            let finalTitle = '';
            if (officialDbTitle) {
              finalTitle = this.sanitizeTitle(officialDbTitle);
            } else if (planTitle) {
              finalTitle = planTitle;
            } else if (userPromptTitle) {
              finalTitle = this.sanitizeTitle(userPromptTitle);
            }

            if (!finalTitle) {
              finalTitle = `Session ${convId.slice(0, 8)}`;
            }

            if (isSubagentText(finalTitle)) continue;

            // Workspace resolution
            let projectName = 'General';
            let workspacePath: string | undefined = undefined;

            const headerText = lines.slice(0, 15).join(' ');
            const headerNorm = headerText.toLowerCase().replace(/\\\\/g, '/').replace(/\\/g, '/');

            // 1. Try matching against known project paths
            for (const [, wsPath] of pathMap.entries()) {
              const normWs = wsPath.toLowerCase().replace(/\\\\/g, '/').replace(/\\/g, '/');
              if (headerNorm.includes(normWs)) {
                workspacePath = wsPath;
                projectName = path.basename(wsPath);
                break;
              }
            }

            // 2. Try matching against known project names as path segments
            if (!workspacePath) {
              for (const name of knownWorkspaces) {
                const nameNorm = `/${name.toLowerCase()}/`;
                if (headerNorm.includes(nameNorm) || headerNorm.includes(`/${name.toLowerCase()}"`)) {
                  if (pathMap.has(name.toLowerCase())) {
                    workspacePath = pathMap.get(name.toLowerCase());
                  }
                  projectName = name;
                  break;
                }
              }
            }

            // 3. Fallback to active workspace folder if matching header
            if (!workspacePath && vscode.workspace.workspaceFolders?.[0]) {
              const currentWs = vscode.workspace.workspaceFolders[0];
              const currentNorm = currentWs.uri.fsPath.toLowerCase().replace(/\\\\/g, '/').replace(/\\/g, '/');
              if (headerNorm.includes(currentNorm) || headerNorm.includes(currentWs.name.toLowerCase())) {
                workspacePath = currentWs.uri.fsPath;
                projectName = currentWs.name;
              }
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
              transcriptPath: tPath,
              stepCount,
              previewText,
              projectName,
              workspacePath,
              tokenEstimate: tokenEstimate || stepCount * 1400,
            });
          } catch {}
        }
      } catch {}
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    // High-precision official title resolution for top 15 recent conversations in-memory:
    const recentBatch = sessions.slice(0, 15);
    await Promise.all(
      recentBatch.map(async (s) => {
        try {
          const official = await this.extractOfficialTitle(s.id);
          if (official && !this.isPlaceholderTitle(official)) {
            const cleanOfficial = this.sanitizeTitle(official);
            if (cleanOfficial && s.title !== cleanOfficial) {
              s.title = cleanOfficial;
            }
          } else if (this.isPlaceholderTitle(s.title)) {
            if (s.previewText) {
              s.title = this.sanitizeTitle(s.previewText);
            }
          }
        } catch {}
      })
    );

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
   * Searches across conversation transcripts for specific text in user prompts or assistant responses.
   */
  private searchCache = new Map<string, { timestamp: number; results: ContentSearchResult[] }>();

  /**
   * High-speed full-text transcript search across conversations.
   * Employs zero-copy Buffer pre-filtering, reverse-chronological early exit,
   * windowed snippet extraction, and LRU search cache for sub-150ms latency.
   */
  public async searchConversationContent(
    query: string,
    scope: 'workspace' | 'all' = 'workspace'
  ): Promise<ContentSearchResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const cacheKey = `${scope}:${cleanQuery.toLowerCase()}`;
    const now = Date.now();
    const cached = this.searchCache.get(cacheKey);
    if (cached && now - cached.timestamp < 15000) {
      return cached.results;
    }

    const sessions =
      scope === 'workspace'
        ? await this.getActiveWorkspaceConversations()
        : await this.getConversations();

    // Sort newest first for highest relevance and fast early completion
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const queryLower = cleanQuery.toLowerCase();
    const queryBuf = Buffer.from(queryLower, 'utf8');
    const results: ContentSearchResult[] = [];

    for (const session of sessions) {
      if (results.length >= 30) {
        break; // Stop once we have 30 top matching conversations
      }

      if (!session.transcriptPath || !fs.existsSync(session.transcriptPath)) {
        continue;
      }

      try {
        // Fast pre-filter: For non-ASCII (e.g. Persian/Arabic/Numbers) casing is byte-identical in UTF-8.
        // For ASCII, verify against lower, exact, and raw string checks.
        const buf = fs.readFileSync(session.transcriptPath);
        const hasAscii = /[a-zA-Z]/.test(cleanQuery);
        if (!hasAscii) {
          if (!buf.includes(queryBuf)) {
            continue;
          }
        } else {
          const exactBuf = Buffer.from(cleanQuery, 'utf8');
          if (!buf.includes(queryBuf) && !buf.includes(exactBuf)) {
            const sample = buf.toString('utf8');
            if (!sample.toLowerCase().includes(queryLower)) {
              continue;
            }
          }
        }

        const rawContent = buf.toString('utf8');
        if (!rawContent.toLowerCase().includes(queryLower)) {
          continue;
        }

        const lines = rawContent.split('\n');
        const snippets: ContentSearchSnippet[] = [];
        let matchCount = 0;

        for (const line of lines) {
          if (!line || !line.toLowerCase().includes(queryLower)) {
            continue;
          }

          // Fast line-level filter: only process actual human requests and AI responses
          const isUserLine = line.includes('"type":"USER_INPUT"') || line.includes('"source":"USER_EXPLICIT"');
          const isAssistantLine = line.includes('"type":"PLANNER_RESPONSE"') || line.includes('"source":"MODEL"');
          if (!isUserLine && !isAssistantLine) {
            continue;
          }

          try {
            const obj = JSON.parse(line);
            const isUser = obj.type === 'USER_INPUT' || obj.source === 'USER_EXPLICIT';
            let raw = typeof obj.content === 'string' ? obj.content : '';
            if (!raw) continue;

            if (isUser) {
              const reqMatch = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
              if (reqMatch && reqMatch[1]) raw = reqMatch[1];
            } else {
              if (raw.includes('<thought>')) {
                raw = raw.replace(/<thought>[\s\S]*?<\/thought>/gi, ' ');
              }
            }

            const rawLower = raw.toLowerCase();
            const idx = rawLower.indexOf(queryLower);
            if (idx === -1) continue;

            matchCount++;

            if (snippets.length < 3) {
              // Extract narrow window around match to avoid running heavy regexes on 500KB responses!
              const winStart = Math.max(0, idx - 50);
              const winEnd = Math.min(raw.length, idx + queryLower.length + 70);
              let excerpt = raw.substring(winStart, winEnd);

              // Clean only the narrow 150-char window (instant < 0.01ms)
              excerpt = excerpt
                .replace(/<[^>]+>/g, ' ')
                .replace(/`([^`]+)`/g, '$1')
                .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
                .replace(/[\r\n\t]+/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .replace(/^[\s,.;:!?"'\-–—=+/\\|~`*#^&{}()[\]<>]+/, '')
                .replace(/[\s,.;:!?"'\-–—=+/\\|~`*#^&{}()[\]<>]+$/, '')
                .trim();

              if (winStart > 0) excerpt = '...' + excerpt;
              if (winEnd < raw.length) excerpt = excerpt + '...';

              const isRtl = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(excerpt);
              const role: 'user' | 'assistant' = isUser ? 'user' : 'assistant';

              if (excerpt.length > 3 && !snippets.some((s) => s.text === excerpt)) {
                snippets.push({ role, text: excerpt, isRtl });
              }
            }
          } catch {}
        }

        if (matchCount > 0) {
          results.push({
            session,
            snippets,
            matchCount,
          });
        }
      } catch (err) {
        console.error(`[ConversationService] Error searching transcript ${session.id}:`, err);
      }
    }

    results.sort((a, b) => b.matchCount - a.matchCount || (b.session.updatedAt || 0) - (a.session.updatedAt || 0));

    // Cache results for instant repeat lookups
    if (this.searchCache.size > 50) {
      const oldestKey = this.searchCache.keys().next().value;
      if (oldestKey) this.searchCache.delete(oldestKey);
    }
    this.searchCache.set(cacheKey, { timestamp: now, results });

    return results;
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
        // 1. Wait 400ms for the native picker UI and search input to render.
        // 2. Send Ctrl+A to clear/select any previous text, then Ctrl+V to paste the title.
        // 3. Wait 600ms for fuzzy search filtering.
        // 4. Send Down Arrow to highlight the top filtered conversation.
        // 5. Wait 400ms.
        // 6. Send Enter to select and open the conversation.
        const vbsContent = [
          'Set WshShell = CreateObject("WScript.Shell")',
          'WScript.Sleep 400',
          'WshShell.SendKeys "^a"',
          'WScript.Sleep 50',
          'WshShell.SendKeys "^v"',
          'WScript.Sleep 600',
          'WshShell.SendKeys "{DOWN}"',
          'WScript.Sleep 400',
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
          'delay 0.4\ntell application "System Events" to keystroke "v" using command down\ndelay 0.6\ntell application "System Events" to key code 125\ndelay 0.4\ntell application "System Events" to key code 36\ndelay 0.2\ntell application "System Events" to key code 36';
        child_process.exec(`osascript -e '${script}'`);
      } catch {
        // ignore
      }
    } else {
      try {
        child_process.exec(
          'sleep 0.4 && xdotool key ctrl+v && sleep 0.6 && xdotool key Down && sleep 0.4 && xdotool key Return && sleep 0.2 && xdotool key Return'
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
    // If session title is placeholder, resolve on-the-fly from official DB or preview before copying!
    if (this.isPlaceholderTitle(session.title) || session.title === session.previewText) {
      const realTitle =
        (await this.extractOfficialTitle(session.id)) ||
        (session.previewText ? this.sanitizeTitle(session.previewText) : '');
      if (realTitle && !this.isPlaceholderTitle(realTitle)) {
        session.title = realTitle;
        this.injectTrajectorySummary(session.id, realTitle, session.workspacePath || '');
      }
    }

    const cleanTitle = session.title.replace(/[\r\n\t]+/g, ' ').trim();

    // 1. If conversation belongs to another project, automatically open in a new window!
    const currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (session.workspacePath && currentWorkspaceFolder && fs.existsSync(session.workspacePath)) {
      const normCurrent = path.normalize(currentWorkspaceFolder).toLowerCase();
      const normTarget = path.normalize(session.workspacePath).toLowerCase();
      if (
        normCurrent !== normTarget &&
        !normCurrent.startsWith(normTarget + path.sep) &&
        !normTarget.startsWith(normCurrent + path.sep)
      ) {
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

        // Copy search query to clipboard (preserves Persian نیم‌فاصله \u200c)
        const searchQuery = cleanTitle
          .replace(/\.{3,}$/, '')
          .replace(/[^\p{L}\p{N}\s\u200c\u200d]/gu, ' ')
          .replace(/[ \t]+/g, ' ')
          .trim()
          .slice(0, 40);
        if (searchQuery) {
          await vscode.env.clipboard.writeText(searchQuery);
        }

        vscode.window.setStatusBarMessage(`$(folder) Opening "${session.projectName}" in new window...`, 4000);

        // Open the destination project in a new window autonomously!
        const targetUri = vscode.Uri.file(session.workspacePath);
        await vscode.commands.executeCommand('vscode.openFolder', targetUri, { forceNewWindow: true });
        return;
      }
    }

    // 2. Prepare clean search query (preserves Persian نیم‌فاصله \u200c, removes dots, ellipsis, special chars, max 40 chars for ideal QuickPick match)
    const searchQuery = cleanTitle
      .replace(/\.{3,}$/, '')
      .replace(/[^\p{L}\p{N}\s\u200c\u200d]/gu, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim()
      .slice(0, 40);

    // 3. Copy search query to clipboard
    if (searchQuery) {
      await vscode.env.clipboard.writeText(searchQuery);
    }

    // 4. Ensure recovered session is registered in Antigravity's state database
    const isRecoveredFromDisk = !this.trajectoryMap.has(session.id);
    if (isRecoveredFromDisk) {
      this.injectTrajectorySummary(session.id, session.title, session.workspacePath || '');
      vscode.window
        .showInformationMessage(
          `Recovered session "${session.title}" synced into Antigravity history.`,
          'View Full Transcript',
          'Reload Window'
        )
        .then((choice) => {
          if (choice === 'View Full Transcript') {
            this.openTranscript(session);
          } else if (choice === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    }

    // 5. Launch automation concurrently in background (DO NOT AWAIT!)
    // vscode.commands.executeCommand on QuickPick blocks until the picker is closed,
    // so automation MUST run concurrently in the background!
    this.automatePasteAndSelect(searchQuery);

    // 6. Open Antigravity's native Conversation Picker (DO NOT AWAIT!)
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
