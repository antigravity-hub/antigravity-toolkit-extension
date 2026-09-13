import * as vscode from 'vscode';
import { ConversationService } from '../services/conversationService';
import { ConversationSession } from '../types';

export class HistoryTreeItem extends vscode.TreeItem {
  constructor(public readonly session: ConversationSession) {
    super(session.title, vscode.TreeItemCollapsibleState.None);

    this.description = `${session.dateFormatted} (${session.stepCount} steps)`;
    this.tooltip = `ID: ${session.id}\nUpdated: ${session.dateFormatted}\nSteps: ${session.stepCount}\nPath: ${session.transcriptPath}`;
    this.contextValue = 'conversationItem';
    this.iconPath = new vscode.ThemeIcon('comment-discussion');

    this.command = {
      command: 'antigravityToolkit.openConversation',
      title: 'Open Transcript',
      arguments: [session],
    };
  }
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<HistoryTreeItem | undefined | null | void> =
    new vscode.EventEmitter<HistoryTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<HistoryTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(private conversationService: ConversationService) {
    this.conversationService.onDidChangeConversations(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: HistoryTreeItem): Promise<HistoryTreeItem[]> {
    if (element) {
      return [];
    }

    const sessions = await this.conversationService.getConversations();
    return sessions.map((s) => new HistoryTreeItem(s));
  }
}
