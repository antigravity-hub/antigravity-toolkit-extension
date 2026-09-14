import * as vscode from 'vscode';
import { QuotaService } from '../services/quotaService';
import { AccountService } from '../services/accountService';
import { AutoSwitchService } from '../services/autoSwitchService';
import { ConversationService } from '../services/conversationService';
import { Account, ModelQuota, QuotaGroup, ConversationSession } from '../types';
import { ShieldBridge } from '../bridge/shieldBridge';

export class QuotaWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravity.views.quota';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly quotaService: QuotaService,
    private readonly accountService: AccountService,
    private readonly autoSwitchService: AutoSwitchService,
    private readonly conversationService: ConversationService
  ) {
    this.quotaService.onDidChangeQuotas(() => this.updateWebview());
    this.accountService.onDidChangeAccounts(() => this.updateWebview());
    this.autoSwitchService.onDidChangeStatus(() => this.updateWebview());
    this.conversationService.onDidChangeConversations(() => this.updateWebview());
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
          this.updateWebview();
          break;
        case 'toggleAutoSwitch':
          const current = this.autoSwitchService.isEnabled();
          await this.autoSwitchService.setEnabled(!current);
          break;
        case 'addAccount':
          await vscode.commands.executeCommand('antigravityToolkit.addAccount');
          break;
        case 'triggerAutoRotate':
          const rotated = await this.autoSwitchService.evaluateQuotasAndRotateIfNeeded();
          if (!rotated) {
            vscode.window.showInformationMessage('Quotas are currently healthy. No rotation needed.');
          }
          break;
        case 'openTranscript':
          if (message.sessionId) {
            const sessions = await this.conversationService.getConversations();
            const target = sessions.find((s) => s.id === message.sessionId);
            if (target) {
              await this.conversationService.openTranscript(target);
            }
          }
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
    const autoSwitchStatus = this.autoSwitchService.getStatus();
    const conversations = await this.conversationService.getConversations();
    const isShieldOnline = await ShieldBridge.getInstance().isShieldOnline();

    this._view.webview.html = this.renderHtml(
      activeAccount,
      quotas,
      accounts,
      autoSwitchStatus,
      conversations,
      isShieldOnline
    );
  }

  private renderHtml(
    activeAccount: Account | undefined,
    quotas: ModelQuota[],
    accounts: Account[],
    autoSwitchStatus: { enabled: boolean; thresholdPercent: number; cooldownMinutes: number },
    conversations: ConversationSession[],
    isShieldOnline: boolean
  ): string {
    const activeEmail = activeAccount ? activeAccount.email : 'No active account';
    const activeTier = activeAccount ? activeAccount.tier || 'Google AI Pro' : 'Free';
    const activeHealth = activeAccount ? Math.round(this.accountService.getAccountHealth(activeAccount)) : 0;
    const isAutoOn = autoSwitchStatus.enabled;

    // Resolve Simplified Groups (Google Gemini & Anthropic Claude) matching Shield
    let geminiGroup: QuotaGroup | undefined;
    let claudeGroup: QuotaGroup | undefined;

    if (activeAccount?.quotaGroups && activeAccount.quotaGroups.length > 0) {
      geminiGroup = activeAccount.quotaGroups.find((g) =>
        g.displayName.toLowerCase().includes('gemini')
      );
      claudeGroup = activeAccount.quotaGroups.find((g) =>
        g.displayName.toLowerCase().includes('claude') || g.displayName.toLowerCase().includes('gpt')
      );
    }

    // Fallbacks if quota_groups not present in account json
    const now = Date.now();
    const fiveHoursMs = 5 * 60 * 60 * 1000;
    const defaultReset = now + 4 * 3600 * 1000 + 12 * 60 * 1000;

    if (!geminiGroup) {
      const geminiQuota = quotas.find((q) => q.modelId.includes('gemini')) || quotas[0];
      const rem = geminiQuota ? geminiQuota.remainingQuota : 68;
      geminiGroup = {
        displayName: 'Google Gemini',
        description: 'Gemini 3.7 Flash, Pro & Thinking',
        fiveHourBucket: {
          bucketId: 'gemini-5h',
          window: '5h',
          remainingPercentage: rem,
          resetTimeMs: geminiQuota ? geminiQuota.resetTimeMs : defaultReset,
          resetTimeFormatted: '04h 01m 35s',
          displayName: 'Five Hour Limit Remaining',
        },
        weeklyBucket: {
          bucketId: 'gemini-weekly',
          window: 'weekly',
          remainingPercentage: 40,
          resetTimeMs: now + 4 * 86400 * 1000,
          resetTimeFormatted: '4d 10h',
          displayName: 'Weekly Limit Remaining',
        },
      };
    }

    if (!claudeGroup) {
      const claudeQuota = quotas.find((q) => q.modelId.includes('claude'));
      const rem = claudeQuota ? claudeQuota.remainingQuota : 100;
      claudeGroup = {
        displayName: 'Anthropic Claude & GPT',
        description: 'Claude Opus 4.6, Sonnet 4.6 & GPT-OSS',
        fiveHourBucket: {
          bucketId: '3p-5h',
          window: '5h',
          remainingPercentage: rem,
          resetTimeMs: defaultReset,
          resetTimeFormatted: '04h 01m 35s',
          displayName: 'Five Hour Limit Remaining',
        },
        weeklyBucket: {
          bucketId: '3p-weekly',
          window: 'weekly',
          remainingPercentage: 65,
          resetTimeMs: now + 6 * 86400 * 1000,
          resetTimeFormatted: '6d 07h',
          displayName: 'Weekly Limit Remaining',
        },
      };
    }

    const renderQuotaCard = (group: QuotaGroup, cardIdx: number) => {
      const fiveHour = group.fiveHourBucket || {
        remainingPercentage: 100,
        resetTimeMs: defaultReset,
        resetTimeFormatted: '05h 00m',
      };
      const weekly = group.weeklyBucket || {
        remainingPercentage: 80,
        resetTimeFormatted: '6d left',
      };

      const radius = 28;
      const circumference = 2 * Math.PI * radius;
      const strokeDashoffset = circumference - (fiveHour.remainingPercentage / 100) * circumference;

      return `
        <div class="quota-group-card" data-reset-ms="${fiveHour.resetTimeMs}">
          <div class="group-header">
            <div class="group-title-col">
              <span class="group-name">${group.displayName}</span>
              <span class="group-desc">${group.description || 'Enterprise AI Quota Pool'}</span>
            </div>
            <span class="pill-shield">${fiveHour.remainingPercentage}% Healthy</span>
          </div>

          <div class="group-body">
            <div class="radial-container">
              <svg class="radial-svg" width="68" height="68" viewBox="0 0 70 70">
                <circle class="radial-bg" cx="35" cy="35" r="${radius}" />
                <circle
                  class="radial-fill"
                  cx="35"
                  cy="35"
                  r="${radius}"
                  style="
                    stroke: #93b93b;
                    stroke-dasharray: ${circumference};
                    stroke-dashoffset: ${strokeDashoffset};
                    filter: drop-shadow(0 0 8px rgba(147, 185, 59, 0.45));
                  "
                />
              </svg>
              <div class="radial-text">
                <span class="radial-percent">${fiveHour.remainingPercentage}%</span>
              </div>
            </div>

            <div class="group-details">
              <div class="metric-row">
                <span class="metric-lbl">5h Rolling:</span>
                <span class="metric-v val-green">${fiveHour.remainingPercentage}% left</span>
              </div>
              <div class="metric-row">
                <span class="metric-lbl">Resets in:</span>
                <span class="metric-v val-ticker" id="countdown-${cardIdx}">${fiveHour.resetTimeFormatted}</span>
              </div>
              <div class="metric-row" style="margin-top: 4px;">
                <span class="metric-lbl">Weekly Limit:</span>
                <span class="metric-v">${weekly.remainingPercentage}% remaining</span>
              </div>
              <div class="mini-bar-bg">
                <div class="mini-bar-fill" style="width: ${weekly.remainingPercentage}%; background: #93b93b;"></div>
              </div>
            </div>
          </div>
        </div>
      `;
    };

    // Group Conversations by Project
    const projectsMap = new Map<string, ConversationSession[]>();
    for (const conv of conversations) {
      const pName = conv.projectName || 'Default Project';
      if (!projectsMap.has(pName)) {
        projectsMap.set(pName, []);
      }
      projectsMap.get(pName)!.push(conv);
    }

    const projectsHtml = Array.from(projectsMap.entries())
      .map(([pName, sessions]) => {
        const totalTokens = sessions.reduce((sum, s) => sum + (s.tokenEstimate || 0), 0);
        const tokensFormatted = totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : `${totalTokens}`;

        const timelineNodes = sessions
          .map((s, sIdx) => {
            const tokens = s.tokenEstimate ? (s.tokenEstimate > 1000 ? `${(s.tokenEstimate / 1000).toFixed(1)}k tokens` : `${s.tokenEstimate} tokens`) : `${s.stepCount * 1.2}k tokens`;
            return `
            <div class="timeline-node" onclick="openTranscript('${s.id}')">
              <div class="node-bullet">
                <span class="node-num">${sIdx + 1}</span>
              </div>
              <div class="node-content">
                <div class="node-header">
                  <span class="node-title" title="${s.title}">${s.title}</span>
                  <span class="node-token-tag">${tokens}</span>
                </div>
                <div class="node-footer">
                  <span>${s.dateFormatted}</span>
                  <span>${s.stepCount} Steps</span>
                  <span class="node-open-btn">Inspect ↗</span>
                </div>
              </div>
            </div>
          `;
          })
          .join('');

        return `
        <div class="project-cluster-card">
          <div class="project-cluster-header">
            <div class="project-name-row">
              <span class="project-icon">📂</span>
              <span class="project-name">${pName}</span>
            </div>
            <div class="project-meta-badges">
              <span class="badge-sessions">${sessions.length} Chats</span>
              <span class="badge-tokens">${tokensFormatted} Tokens</span>
            </div>
          </div>
          <div class="timeline-tree">
            ${timelineNodes}
          </div>
        </div>
      `;
      })
      .join('');

    // Switchboard Account Cards
    const accountCardsHtml = accounts
      .map((acc) => {
        const isActive = acc.isActive;
        const health = Math.round(this.accountService.getAccountHealth(acc));
        const initials = acc.email.slice(0, 2).toUpperCase();

        let healthColor = '#93b93b';
        let statusBadge = '🟢 Ready';
        if (isActive) {
          statusBadge = '⚡ Active';
        } else if (health <= 5) {
          healthColor = '#f43f5e';
          statusBadge = '🔴 Depleted';
        } else if (health <= 35) {
          healthColor = '#f59e0b';
          statusBadge = '🟡 Low';
        }

        return `
        <div class="account-card ${isActive ? 'account-active-glow' : ''}">
          <div class="account-card-header">
            <div class="account-avatar-wrapper">
              ${
                acc.avatarUrl
                  ? `<img class="account-avatar-img" src="${acc.avatarUrl}" alt="${acc.email}" />`
                  : `<div class="account-avatar-fallback">${initials}</div>`
              }
              ${isActive ? '<span class="active-pulse-beacon"></span>' : ''}
            </div>
            <div class="account-text-details">
              <div class="account-email" title="${acc.email}">${acc.email}</div>
              <div class="account-subrow">
                <span class="tier-pill">${acc.tier || 'Google AI Pro'}</span>
                <span class="status-pill">${statusBadge}</span>
              </div>
            </div>
          </div>

          <div class="account-health-row">
            <div class="health-meta">
              <span>Quota Capacity</span>
              <span style="color: ${healthColor}; font-weight: 700;">${health}%</span>
            </div>
            <div class="mini-health-bar-bg">
              <div class="mini-health-bar-fill" style="width: ${health}%; background: ${healthColor};"></div>
            </div>
          </div>

          <div class="account-card-action">
            ${
              isActive
                ? `<button class="btn-account-active" disabled>
                    ✓ Current Active Session
                   </button>`
                : `<button class="btn-switch-account" onclick="switchAccount('${acc.email}')">
                    ⚡ Switch to Session
                   </button>`
            }
          </div>
        </div>
      `;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Toolkit 2.0</title>
  <style>
    :root {
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      --shield-green: #93b93b;
      --shield-green-light: #a8cf45;
      --shield-green-dark: #7a9c2d;
      --shield-green-glow: rgba(147, 185, 59, 0.4);
      --shield-green-bg: rgba(147, 185, 59, 0.12);
      --bg-surface: #0a0e17;
      --card-bg: rgba(15, 22, 36, 0.85);
      --card-border: rgba(147, 185, 59, 0.22);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
    }

    body {
      font-family: var(--font-family);
      background: transparent;
      color: var(--text-main);
      padding: 10px;
      overflow-x: hidden;
    }

    /* Outer Wrapper */
    .toolkit-wrapper {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    /* Brand Header */
    .brand-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: linear-gradient(135deg, rgba(20, 29, 46, 0.95) 0%, rgba(13, 19, 32, 0.98) 100%);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 10px 12px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .brand-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-shield-svg {
      width: 24px;
      height: 24px;
      fill: none;
      stroke: var(--shield-green);
      stroke-width: 2;
      filter: drop-shadow(0 0 6px var(--shield-green-glow));
      animation: pulseShield 3s ease-in-out infinite alternate;
    }

    @keyframes pulseShield {
      0% { transform: scale(1); filter: drop-shadow(0 0 4px var(--shield-green-glow)); }
      100% { transform: scale(1.08); filter: drop-shadow(0 0 10px var(--shield-green-glow)); }
    }

    .brand-title-text {
      font-size: 12.5px;
      font-weight: 700;
      color: #fff;
      letter-spacing: 0.03em;
    }

    .brand-version-pill {
      font-size: 9px;
      font-weight: 700;
      background: var(--shield-green-bg);
      border: 1px solid var(--card-border);
      color: var(--shield-green-light);
      padding: 1px 6px;
      border-radius: 999px;
    }

    .shield-status-indicator {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      color: ${isShieldOnline ? 'var(--shield-green-light)' : '#94a3b8'};
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 3px 8px;
      border-radius: 20px;
    }

    .shield-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: ${isShieldOnline ? 'var(--shield-green)' : '#64748b'};
      box-shadow: ${isShieldOnline ? '0 0 6px var(--shield-green)' : 'none'};
    }

    /* Smart Dynamic Responsive Tabs Navigation */
    .tab-navigation {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(68px, 1fr));
      gap: 6px;
      background: rgba(13, 19, 32, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      padding: 5px;
    }

    .tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      padding: 6px 4px;
      border-radius: 8px;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .tab-btn:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.05);
    }

    .tab-btn.active {
      background: var(--shield-green-bg);
      border-color: var(--shield-green);
      color: var(--shield-green-light);
      box-shadow: 0 0 10px rgba(147, 185, 59, 0.25);
    }

    .tab-btn .tab-icon {
      font-size: 13px;
    }

    /* Tab Contents */
    .tab-content {
      display: none;
      flex-direction: column;
      gap: 12px;
    }

    .tab-content.active {
      display: flex;
    }

    /* Active Session Card */
    .active-session-card {
      background: linear-gradient(135deg, rgba(20, 30, 48, 0.9) 0%, rgba(15, 22, 36, 0.95) 100%);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
    }

    .active-session-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .active-session-email {
      font-size: 12.5px;
      font-weight: 700;
      color: #fff;
      word-break: break-all;
    }

    .active-meta-badges {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .pill-tier {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--shield-green-bg);
      border: 1px solid var(--card-border);
      color: var(--shield-green-light);
    }

    .pill-health {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      color: #f1f5f9;
    }

    /* Auto-Rotate Bar */
    .auto-rotate-bar {
      background: rgba(15, 22, 36, 0.7);
      border: 1px solid ${isAutoOn ? 'var(--shield-green)' : 'rgba(255, 255, 255, 0.08)'};
      border-radius: 12px;
      padding: 8px 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: ${isAutoOn ? '0 0 14px -2px rgba(147, 185, 59, 0.25)' : 'none'};
      transition: all 0.25s ease;
    }

    .auto-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .auto-beacon {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: ${isAutoOn ? 'var(--shield-green)' : '#64748b'};
      box-shadow: ${isAutoOn ? '0 0 8px var(--shield-green)' : 'none'};
      animation: ${isAutoOn ? 'pulseWave 2s infinite' : 'none'};
    }

    @keyframes pulseWave {
      0% { transform: scale(0.8); opacity: 1; }
      50% { transform: scale(1.2); opacity: 0.7; }
      100% { transform: scale(0.8); opacity: 1; }
    }

    .auto-text-main {
      font-size: 10.5px;
      font-weight: 700;
      color: ${isAutoOn ? 'var(--shield-green-light)' : '#94a3b8'};
    }

    .auto-text-sub {
      font-size: 9.5px;
      color: var(--text-muted);
    }

    .btn-toggle-auto {
      background: ${isAutoOn ? 'linear-gradient(135deg, #7a9c2d 0%, #93b93b 100%)' : 'rgba(255,255,255,0.08)'};
      color: #fff;
      border: 1px solid ${isAutoOn ? 'var(--shield-green-light)' : 'rgba(255,255,255,0.1)'};
      padding: 4px 10px;
      border-radius: 16px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 0.15s ease;
    }

    .btn-toggle-auto:hover {
      transform: scale(1.05);
    }

    /* Section Subheads */
    .subhead-title {
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 2px;
    }

    /* Quota Group Cards (Gemini & Claude) */
    .quota-group-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      backdrop-filter: blur(10px);
    }

    .group-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }

    .group-name {
      font-size: 12px;
      font-weight: 700;
      color: #fff;
    }

    .group-desc {
      font-size: 9.5px;
      color: var(--text-muted);
    }

    .pill-shield {
      font-size: 9px;
      font-weight: 700;
      background: var(--shield-green-bg);
      color: var(--shield-green-light);
      border: 1px solid var(--card-border);
      padding: 1px 6px;
      border-radius: 4px;
    }

    .group-body {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .radial-container {
      position: relative;
      width: 60px;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .radial-svg {
      transform: rotate(-90deg);
      width: 60px;
      height: 60px;
    }

    .radial-bg {
      fill: none;
      stroke: rgba(255, 255, 255, 0.07);
      stroke-width: 5;
    }

    .radial-fill {
      fill: none;
      stroke-width: 5;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.8s ease;
    }

    .radial-text {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .radial-percent {
      font-size: 11px;
      font-weight: 700;
      color: #fff;
    }

    .group-details {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .metric-row {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--text-muted);
    }

    .metric-v {
      font-weight: 600;
      color: #cbd5e1;
    }

    .val-green {
      color: var(--shield-green-light);
    }

    .val-ticker {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: var(--shield-green-light);
    }

    .mini-bar-bg {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 2px;
    }

    .mini-bar-fill {
      height: 100%;
      border-radius: 2px;
    }

    /* Switchboard Cards */
    .accounts-grid {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .account-card {
      background: var(--card-bg);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 9px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      transition: border-color 0.2s ease;
    }

    .account-active-glow {
      border: 1px solid var(--shield-green);
      box-shadow: 0 0 12px -2px var(--shield-green-glow);
    }

    .account-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .account-avatar-wrapper {
      position: relative;
      width: 28px;
      height: 28px;
      flex-shrink: 0;
    }

    .account-avatar-img {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      object-fit: cover;
    }

    .account-avatar-fallback {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1e293b, #334155);
      color: var(--shield-green-light);
      font-size: 10.5px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .active-pulse-beacon {
      position: absolute;
      bottom: -1px;
      right: -1px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--shield-green);
      border: 1.5px solid #0f172a;
    }

    .account-text-details {
      flex: 1;
      min-width: 0;
    }

    .account-email {
      font-size: 11px;
      font-weight: 600;
      color: #f1f5f9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .account-subrow {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 1px;
    }

    .tier-pill {
      font-size: 8.5px;
      background: rgba(255, 255, 255, 0.06);
      color: #cbd5e1;
      padding: 1px 5px;
      border-radius: 3px;
    }

    .status-pill {
      font-size: 8.5px;
      color: #94a3b8;
    }

    .account-health-row {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .health-meta {
      display: flex;
      justify-content: space-between;
      font-size: 9.5px;
      color: var(--text-muted);
    }

    .mini-health-bar-bg {
      width: 100%;
      height: 3.5px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      overflow: hidden;
    }

    .mini-health-bar-fill {
      height: 100%;
      border-radius: 2px;
    }

    .account-card-action button {
      width: 100%;
      border: none;
      padding: 5px 8px;
      border-radius: 6px;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.2s ease;
    }

    .btn-switch-account {
      background: rgba(255, 255, 255, 0.08);
      color: #f1f5f9;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
    }

    .btn-switch-account:hover {
      background: var(--shield-green-bg);
      border-color: var(--shield-green) !important;
      color: var(--shield-green-light);
    }

    .btn-account-active {
      background: var(--shield-green-bg);
      color: var(--shield-green-light);
      border: 1px solid var(--card-border) !important;
      cursor: default;
    }

    /* Project Timeline Graph (Tab 2) */
    .project-cluster-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .project-cluster-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      padding-bottom: 6px;
    }

    .project-name-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .project-name {
      font-size: 11.5px;
      font-weight: 700;
      color: #fff;
    }

    .project-meta-badges {
      display: flex;
      gap: 4px;
    }

    .badge-sessions, .badge-tokens {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 4px;
    }

    .badge-sessions {
      background: rgba(255, 255, 255, 0.08);
      color: #cbd5e1;
    }

    .badge-tokens {
      background: var(--shield-green-bg);
      color: var(--shield-green-light);
      border: 1px solid var(--card-border);
    }

    .timeline-tree {
      display: flex;
      flex-direction: column;
      gap: 6px;
      position: relative;
      padding-left: 12px;
      border-left: 1.5px dashed var(--shield-green-glow);
      margin-left: 8px;
    }

    .timeline-node {
      position: relative;
      background: rgba(20, 28, 44, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      padding: 6px 8px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .timeline-node:hover {
      background: rgba(147, 185, 59, 0.08);
      border-color: var(--shield-green);
      transform: translateX(2px);
    }

    .node-bullet {
      position: absolute;
      left: -19px;
      top: 10px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #0f172a;
      border: 1.5px solid var(--shield-green);
      color: var(--shield-green-light);
      font-size: 8px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .node-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }

    .node-title {
      font-size: 10.5px;
      font-weight: 600;
      color: #f1f5f9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 170px;
    }

    .node-token-tag {
      font-size: 8.5px;
      color: var(--shield-green-light);
      background: var(--shield-green-bg);
      padding: 1px 4px;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .node-footer {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      color: var(--text-muted);
      margin-top: 3px;
    }

    .node-open-btn {
      color: var(--shield-green-light);
      font-weight: 600;
    }

    /* Tab 3: Remote Control */
    .remote-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      text-align: center;
    }

    .remote-icon-wrapper {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--shield-green-bg);
      border: 1px solid var(--shield-green);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      margin: 0 auto;
      box-shadow: 0 0 12px var(--shield-green-glow);
    }

    .remote-title {
      font-size: 12px;
      font-weight: 700;
      color: #fff;
    }

    .remote-desc {
      font-size: 10px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .remote-action-btn {
      background: linear-gradient(135deg, #7a9c2d 0%, #93b93b 100%);
      color: #fff;
      border: none;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    /* Tab 4: Shield Bridge */
    .bridge-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .bridge-row {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      padding-bottom: 6px;
    }

    .bridge-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }

    .bridge-val {
      font-weight: 600;
      color: var(--shield-green-light);
    }

    /* Quick Action Dock */
    .dock-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-top: 2px;
    }

    .btn-dock {
      background: rgba(20, 29, 46, 0.8);
      border: 1px solid var(--card-border);
      color: #cbd5e1;
      padding: 7px 8px;
      border-radius: 8px;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.2s ease;
    }

    .btn-dock:hover {
      background: var(--shield-green-bg);
      color: #fff;
      border-color: var(--shield-green);
    }

    .btn-dock.primary-action {
      grid-column: span 2;
      background: linear-gradient(135deg, #7a9c2d 0%, #93b93b 100%);
      border: 1px solid var(--shield-green-light);
      color: #fff;
      box-shadow: 0 2px 10px rgba(147, 185, 59, 0.35);
    }
  </style>
</head>
<body>
  <div class="toolkit-wrapper">

    <!-- Brand Header -->
    <div class="brand-header">
      <div class="brand-left">
        <!-- Antigravity Shield Logo -->
        <svg class="brand-shield-svg" viewBox="0 0 24 24">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
        <span class="brand-title-text">Antigravity Shield</span>
        <span class="brand-version-pill">v2.0</span>
      </div>
      <div class="shield-status-indicator" title="${isShieldOnline ? 'Connected to local Shield daemon (Port 8045)' : 'Shield daemon unreachable on port 8045'}">
        <span class="shield-dot"></span>
        <span>${isShieldOnline ? 'Shield Linked' : 'Shield Offline'}</span>
      </div>
    </div>

    <!-- Smart Responsive Tabs Navigation -->
    <div class="tab-navigation">
      <button class="tab-btn active" onclick="switchTab('overview')">
        <span class="tab-icon">⚡</span>
        <span>Overview</span>
      </button>
      <button class="tab-btn" onclick="switchTab('history')">
        <span class="tab-icon">📜</span>
        <span>Chats</span>
      </button>
      <button class="tab-btn" onclick="switchTab('remote')">
        <span class="tab-icon">📱</span>
        <span>Remote</span>
      </button>
      <button class="tab-btn" onclick="switchTab('bridge')">
        <span class="tab-icon">🛡️</span>
        <span>Bridge</span>
      </button>
    </div>

    <!-- TAB 1: OVERVIEW -->
    <div id="tab-overview" class="tab-content active">
      <!-- Active Session Card -->
      <div class="active-session-card">
        <div class="active-session-top">
          <span style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Active Session</span>
          <div class="active-meta-badges">
            <span class="pill-tier">${activeTier}</span>
            <span class="pill-health">${activeHealth}% Pool Health</span>
          </div>
        </div>
        <div class="active-session-email">${activeEmail}</div>
      </div>

      <!-- Auto-Rotate Smart Switch HUD Bar -->
      <div class="auto-rotate-bar">
        <div class="auto-left">
          <div class="auto-beacon"></div>
          <div>
            <div class="auto-text-main">${isAutoOn ? 'AUTO-ROTATE: ACTIVE' : 'AUTO-ROTATE: PAUSED'}</div>
            <div class="auto-text-sub">Switches automatically on ≤${autoSwitchStatus.thresholdPercent}% quota</div>
          </div>
        </div>
        <button class="btn-toggle-auto" onclick="toggleAutoSwitch()">
          ${isAutoOn ? 'ON ⚡' : 'OFF'}
        </button>
      </div>

      <!-- Simplified Quota Groups (Gemini & Claude) -->
      <div class="subhead-title">
        <span>AI Quotas & Windows</span>
        <span style="font-size: 9px; color: var(--shield-green-light);">Shield Engine</span>
      </div>

      ${renderQuotaCard(geminiGroup, 0)}
      ${renderQuotaCard(claudeGroup, 1)}

      <!-- Multi-Account Switchboard Cards -->
      <div class="subhead-title">
        <span>Sessions Switchboard (${accounts.length})</span>
        <span style="font-size: 9px;">Zero-Reload</span>
      </div>

      <div class="accounts-grid">
        ${accountCardsHtml || '<div style="opacity:0.6; text-align:center; padding:8px;">No accounts stored</div>'}
      </div>

      <!-- Dock Actions -->
      <div class="dock-actions">
        <button class="btn-dock primary-action" onclick="syncShield()">
          <span>🔄 Sync with Antigravity Shield</span>
        </button>
        <button class="btn-dock" onclick="addAccount()">
          <span>➕ Add Account</span>
        </button>
        <button class="btn-dock" onclick="triggerAutoRotate()">
          <span>⚡ Test Rotate</span>
        </button>
      </div>
    </div>

    <!-- TAB 2: CHATS & PROJECT GRAPH -->
    <div id="tab-history" class="tab-content">
      <div class="subhead-title">
        <span>Conversations by Project</span>
        <span style="font-size: 9px; color: var(--shield-green-light);">${conversations.length} Total Sessions</span>
      </div>

      ${projectsHtml || '<div style="opacity:0.6; text-align:center; padding:16px;">No conversation transcripts found</div>'}
    </div>

    <!-- TAB 3: REMOTE CONTROL -->
    <div id="tab-remote" class="tab-content">
      <div class="remote-card">
        <div class="remote-icon-wrapper">📱</div>
        <div class="remote-title">Antigravity Mobile & Telegram</div>
        <div class="remote-desc">
          Monitor your AI coding sessions, receive prompt completion alerts, and control IDE tasks remotely from your smartphone or Telegram bot.
        </div>
        <button class="remote-action-btn" onclick="syncShield()">
          <span>⚡ Pair Telegram Bot</span>
        </button>
      </div>

      <div class="remote-card">
        <div class="remote-icon-wrapper">🤖</div>
        <div class="remote-title">Agent Auto-Approve Policies</div>
        <div class="remote-desc">
          Zero-Token Waste execution & headless auto-accept policies for Antigravity Coding Agents.
        </div>
        <button class="btn-dock" style="width: 100%;" onclick="triggerAutoRotate()">
          <span>🛡️ Configure Safety Gates</span>
        </button>
      </div>
    </div>

    <!-- TAB 4: SHIELD BRIDGE -->
    <div id="tab-bridge" class="tab-content">
      <div class="bridge-card">
        <div class="bridge-row">
          <span>Shield Daemon Status:</span>
          <span class="bridge-val">${isShieldOnline ? '🟢 Connected' : '⚪ Offline'}</span>
        </div>
        <div class="bridge-row">
          <span>Local Bridge Port:</span>
          <span class="bridge-val">8045 / 8765</span>
        </div>
        <div class="bridge-row">
          <span>Active IDE:</span>
          <span class="bridge-val">Antigravity IDE</span>
        </div>
        <div class="bridge-row">
          <span>Auto-Switch Threshold:</span>
          <span class="bridge-val">≤ ${autoSwitchStatus.thresholdPercent}%</span>
        </div>
        <div class="bridge-row">
          <span>Cooldown Period:</span>
          <span class="bridge-val">${autoSwitchStatus.cooldownMinutes} Minutes</span>
        </div>
      </div>

      <button class="btn-dock primary-action" onclick="syncShield()">
        <span>🔄 Force Heartbeat & Telemetry Sync</span>
      </button>
    </div>

  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      const targetBtn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick').includes(tabId));
      if (targetBtn) targetBtn.classList.add('active');

      const targetContent = document.getElementById('tab-' + tabId);
      if (targetContent) targetContent.classList.add('active');
    }

    function switchAccount(email) {
      if (email) {
        vscode.postMessage({ command: 'switchAccount', email: email });
      }
    }

    function syncShield() {
      vscode.postMessage({ command: 'syncShield' });
    }

    function toggleAutoSwitch() {
      vscode.postMessage({ command: 'toggleAutoSwitch' });
    }

    function addAccount() {
      vscode.postMessage({ command: 'addAccount' });
    }

    function triggerAutoRotate() {
      vscode.postMessage({ command: 'triggerAutoRotate' });
    }

    function openTranscript(sessionId) {
      if (sessionId) {
        vscode.postMessage({ command: 'openTranscript', sessionId: sessionId });
      }
    }

    // Live countdown timer script ticking every 1 second in DOM
    setInterval(() => {
      const cards = document.querySelectorAll('.quota-group-card');
      const now = Date.now();

      cards.forEach((card, idx) => {
        const resetMs = parseInt(card.getAttribute('data-reset-ms'), 10);
        if (isNaN(resetMs) || resetMs <= 0) return;

        const diff = Math.max(0, resetMs - now);
        const totalSeconds = Math.floor(diff / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const pad = (n) => (n < 10 ? '0' + n : '' + n);
        let formatted = '';
        if (hours > 0) {
          formatted = pad(hours) + 'h ' + pad(minutes) + 'm ' + pad(seconds) + 's';
        } else {
          formatted = pad(minutes) + 'm ' + pad(seconds) + 's';
        }

        const el = document.getElementById('countdown-' + idx);
        if (el) {
          el.innerText = formatted;
        }
      });
    }, 1000);
  </script>
</body>
</html>`;
  }
}
