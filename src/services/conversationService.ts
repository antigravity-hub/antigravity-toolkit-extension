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
      path.join(homeDir, '.gemini', 'antigravity-ide', 'brain'),
      path.join(homeDir, '.gemini', 'brain'),
    ];

    // Check workspace root folders
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        dirs.push(path.join(folder.uri.fsPath, '.gemini', 'brain'));
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

    for (const brainDir of brainDirs) {
      try {
        const entries = fs.readdirSync(brainDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.')) continue;

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

          let stepCount = 0;
          let previewText = '';
          let mtime = 0;

          try {
            const stat = fs.statSync(sessionDir);
            mtime = stat.mtimeMs;
          } catch {
            mtime = Date.now();
          }

          if (transcriptPath && fs.existsSync(transcriptPath)) {
            try {
              const content = fs.readFileSync(transcriptPath, 'utf8');
              const lines = content.split('\n').filter((l) => l.trim().length > 0);
              stepCount = lines.length;

              // Extract first user input as title / preview
              for (const line of lines.slice(0, 10)) {
                try {
                  const obj = JSON.parse(line);
                  if (obj.type === 'USER_INPUT' && obj.content) {
                    previewText = String(obj.content).slice(0, 120);
                    break;
                  }
                } catch {
                  // ignore JSON parse errors on malformed lines
                }
              }
            } catch {
              // ignore file read error
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
            title: previewText || `Session ${convId.slice(0, 8)}`,
            createdAt: mtime,
            updatedAt: mtime,
            dateFormatted,
            transcriptPath,
            stepCount,
            previewText,
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
