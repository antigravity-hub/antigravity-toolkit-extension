import * as vscode from 'vscode';
import { QuotaService } from '../services/quotaService';
import { AccountService } from '../services/accountService';

export class QuotaWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravity.views.quota';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly quotaService: QuotaService,
    private readonly accountService: AccountService
  ) {
    this.quotaService.onDidChangeQuotas(() => this.updateWebview());
    this.accountService.onDidChangeAccounts(() => this.updateWebview());
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'refresh':
          this.quotaService.notifyQuotasUpdated();
          break;
        case 'switchAccount':
          if (message.email) {
            await this.accountService.switchAccount(message.email);
          }
          break;
        case 'syncShield':
          await this.accountService.syncFromShield();
          break;
      }
    });

    this.updateWebview();
  }

  public async updateWebview(): Promise<void> {
    if (!this._view) {
      return;
    }

    const quotas = await this.quotaService.getActiveQuotas();
    const activeAccount = this.accountService.getActiveAccount();
    const accounts = this.accountService.getAccounts();

    this._view.webview.html = this.renderHtml(activeAccount, quotas, accounts);
  }

  private renderHtml(activeAccount: any, quotas: any[], accounts: any[]): string {
    const activeEmail = activeAccount ? activeAccount.email : 'No active account';
    const activeTier = activeAccount ? activeAccount.tier || 'Free' : '-';

    const quotaRows = quotas
      .map((q) => {
        const remaining = Math.max(0, 100 - q.usagePercentage);
        const color =
          remaining > 50
            ? 'var(--vscode-charts-green, #4caf50)'
            : remaining > 20
            ? 'var(--vscode-charts-yellow, #ff9800)'
            : 'var(--vscode-charts-red, #f44336)';

        return `
        <div class="model-card">
          <div class="model-header">
            <span class="model-name">${q.displayName}</span>
            <span class="model-badge">${remaining}% left</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: ${remaining}%; background-color: ${color};"></div>
          </div>
          <div class="model-footer">
            <span>Window: ${q.windowType === 'rolling_5h' ? '5h Rolling' : 'Weekly'}</span>
            <span>Resets in: <strong>${q.resetTimeFormatted}</strong></span>
          </div>
        </div>
      `;
      })
      .join('');

    const accountOptions = accounts
      .map(
        (acc) => `
        <option value="${acc.email}" ${acc.isActive ? 'selected' : ''}>
          ${acc.email} (${acc.tier || 'Ready'})
        </option>
      `
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 10px;
      margin: 0;
      background-color: transparent;
    }
    .header-box {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 12px;
    }
    .active-account-title {
      font-size: 11px;
      text-transform: uppercase;
      opacity: 0.7;
      margin-bottom: 4px;
    }
    .active-account-email {
      font-weight: 600;
      font-size: 13px;
      word-break: break-all;
    }
    .active-account-tier {
      display: inline-block;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      margin-top: 4px;
    }
    .model-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 8px;
    }
    .model-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .model-name {
      font-weight: 600;
      font-size: 12px;
    }
    .model-badge {
      font-size: 11px;
      font-weight: bold;
    }
    .progress-bar-bg {
      height: 6px;
      border-radius: 3px;
      background: rgba(128,128,128,0.2);
      overflow: hidden;
      margin-bottom: 6px;
    }
    .progress-bar-fill {
      height: 100%;
      transition: width 0.3s ease;
    }
    .model-footer {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      opacity: 0.75;
    }
    .actions-box {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    button, select {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      width: 100%;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.3));
    }
  </style>
</head>
<body>
  <div class="header-box">
    <div class="active-account-title">Active Account</div>
    <div class="active-account-email">${activeEmail}</div>
    <div class="active-account-tier">Plan: ${activeTier}</div>
  </div>

  <div class="quotas-list">
    ${quotaRows || '<div style="opacity:0.7; text-align:center;">No quota telemetry available</div>'}
  </div>

  <div class="actions-box">
    <select id="switchSelect" onchange="onSwitchSelect(this.value)">
      <option disabled ${!activeAccount ? 'selected' : ''}>-- Quick Switch Account --</option>
      ${accountOptions}
    </select>
    <button class="secondary" onclick="syncShield()">⚡ Sync from Shield</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function onSwitchSelect(email) {
      if (email) {
        vscode.postMessage({ command: 'switchAccount', email: email });
      }
    }

    function syncShield() {
      vscode.postMessage({ command: 'syncShield' });
    }
  </script>
</body>
</html>`;
  }
}
