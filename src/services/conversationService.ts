import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConversationSession, ConversationStep } from '../types';

export class ConversationService {
  private static instance: ConversationService;
  private onDidChangeConversationsEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeConversations = this.onDidChangeConversationsEmitter.event;

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
   * Scans and returns all discovered conversations sorted by latest activity.
   */
  public async getConversations(): Promise<ConversationSession[]> {
    const brainDirs = this.getBrainDirectories();
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

            // Extract project name & first clean user input as title / preview
            for (const line of lines.slice(0, 30)) {
              try {
                const obj = JSON.parse(line);
                const str = JSON.stringify(obj);

                // Extract project name from workspace mapping or paths
                if (!projectName) {
                  const corpusMatch = str.match(/->\s*([a-zA-Z0-9_\-\.\/]+)/);
                  if (corpusMatch && corpusMatch[1] && !corpusMatch[1].includes('{') && !corpusMatch[1].includes('[')) {
                    projectName = path.basename(corpusMatch[1]);
                  } else {
                    const pathMatch = str.match(/([a-zA-Z]:\\[^"'\n\r\t]+)/);
                    if (pathMatch && pathMatch[1]) {
                      const cleanPath = pathMatch[1].replace(/\\+$/, '');
                      const bName = path.basename(cleanPath);
                      if (bName && !['brain', 'logs', 'tasks', 'AppData', 'Users', 'Programs', 'system_generated', 'scratch'].includes(bName)) {
                        projectName = bName;
                      }
                    }
                  }
                }

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

          if (stepCount === 0 && !previewText) {
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
            title: previewText || `Session ${convId.slice(0, 8)}`,
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
