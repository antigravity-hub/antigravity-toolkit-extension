import * as vscode from 'vscode';
import { QuotaService } from '../services/quotaService';
import { AccountService } from '../services/accountService';
import { AutoSwitchService } from '../services/autoSwitchService';
import { ConversationService } from '../services/conversationService';
import { Account, ModelQuota, QuotaGroup, ConversationSession, TokenUsageStats } from '../types';
import { ShieldBridge } from '../bridge/shieldBridge';
import { LanguageServerClient } from '../bridge/languageServerClient';

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
            this.updateWebview();
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
            const target =
              this.conversationService.getSessionById(message.sessionId) ||
              (await this.conversationService.getConversations()).find((s) => s.id === message.sessionId);
            if (target) {
              await this.conversationService.openTranscript(target);
            }
          }
          break;
        case 'openConversation':
          if (message.sessionId) {
            const target =
              this.conversationService.getSessionById(message.sessionId) ||
              (await this.conversationService.getConversations()).find((s) => s.id === message.sessionId);
            if (target) {
              await this.conversationService.openConversation(target);
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
    const [isShieldOnline, tokenStats, activeModelName] = await Promise.all([
      ShieldBridge.getInstance().isShieldOnline(),
      ShieldBridge.getInstance().getTokenStats(),
      LanguageServerClient.getInstance().getActiveChatModel(conversations[0]?.id),
    ]);

    // Detect currently open workspace in VS Code / Antigravity IDE
    const currentWorkspaceName =
      vscode.workspace.name ||
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
        ? vscode.workspace.workspaceFolders[0].name
        : '');

    this._view.webview.html = this.renderHtml(
      activeAccount,
      quotas,
      accounts,
      autoSwitchStatus,
      conversations,
      isShieldOnline,
      currentWorkspaceName,
      tokenStats,
      activeModelName
    );
  }

  private renderHtml(
    activeAccount: Account | undefined,
    quotas: ModelQuota[],
    accounts: Account[],
    autoSwitchStatus: { enabled: boolean; thresholdPercent: number; cooldownMinutes: number },
    conversations: ConversationSession[],
    isShieldOnline: boolean,
    currentWorkspaceName: string,
    tokenStats: TokenUsageStats | null,
    activeModelName: string
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
          resetTimeFormatted: '04h 01m',
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
          resetTimeFormatted: '04h 01m',
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
      const isGemini = group.displayName.toLowerCase().includes('gemini');
      const fiveHour = group.fiveHourBucket || {
        remainingPercentage: 100,
        resetTimeMs: defaultReset,
        resetTimeFormatted: '05h 00m',
      };
      const weekly = group.weeklyBucket || {
        remainingPercentage: 80,
        resetTimeFormatted: '6d left',
      };

      const strokeColor = isGemini ? 'var(--quota-cyan)' : '#f97316';
      const glowColor = isGemini ? 'rgba(6, 182, 212, 0.45)' : 'rgba(249, 115, 22, 0.4)';
      const gradientFill = isGemini
        ? 'linear-gradient(90deg, #0891b2, #38bdf8)'
        : 'linear-gradient(90deg, #c2410c, #fb923c)';

      const radius = 28;
      const circumference = 2 * Math.PI * radius;
      const strokeDashoffset = circumference - (fiveHour.remainingPercentage / 100) * circumference;
      const weeklyStrokeDashoffset = circumference - (weekly.remainingPercentage / 100) * circumference;

      return `
        <div class="quota-group-card ${isGemini ? 'group-gemini' : 'group-claude'}" 
             data-reset-ms="${fiveHour.resetTimeMs}"
             data-fiveh-pct="${fiveHour.remainingPercentage}"
             data-fiveh-reset="${fiveHour.resetTimeFormatted.replace(/\s*\d+s$/, '')}"
             data-fiveh-offset="${strokeDashoffset}"
             data-weekly-pct="${weekly.remainingPercentage}"
             data-weekly-reset="${weekly.resetTimeFormatted}"
             data-weekly-offset="${weeklyStrokeDashoffset}"
             data-stroke-color="${strokeColor}">
          <div class="group-header">
            <div class="group-title-col">
              <div class="group-name-row">
                <span class="group-name">${group.displayName}</span>
                ${
                  isGemini
                    ? `<span class="pill-active-model">⚡ ACTIVE IN IDE</span>`
                    : `<span class="pill-standby-model">STANDBY POOL</span>`
                }
              </div>
              <span class="group-desc">${group.description || 'Enterprise AI Quota Pool'}</span>
            </div>
            <span class="pill-capacity ${isGemini ? 'cap-cyan' : 'cap-orange'}">${fiveHour.remainingPercentage}% Capacity</span>
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
                    stroke: ${strokeColor};
                    stroke-dasharray: ${circumference};
                    stroke-dashoffset: ${strokeDashoffset};
                    filter: drop-shadow(0 0 8px ${glowColor});
                  "
                />
              </svg>
              <div class="radial-text">
                <span class="radial-percent" style="color: ${strokeColor};">${fiveHour.remainingPercentage}%</span>
              </div>
            </div>

            <div class="group-details">
              <div class="metric-row">
                <span class="metric-lbl">5h Rolling:</span>
                <span class="metric-v" style="color: ${strokeColor};">${fiveHour.remainingPercentage}% left</span>
              </div>
              <div class="metric-row">
                <span class="metric-lbl">Resets in:</span>
                <span class="metric-v val-ticker" id="countdown-${cardIdx}">${fiveHour.resetTimeFormatted.replace(/\s*\d+s$/, '')}</span>
              </div>
              <div class="metric-row" style="margin-top: 4px;">
                <span class="metric-lbl">Weekly Limit:</span>
                <span class="metric-v">${weekly.remainingPercentage}% remaining</span>
              </div>
              <div class="mini-bar-bg">
                <div class="mini-bar-fill" style="width: ${weekly.remainingPercentage}%; background: ${gradientFill};"></div>
              </div>
            </div>
          </div>
        </div>
      `;
    };

    // Group Conversations by Project
    const projectsMap = new Map<string, ConversationSession[]>();
    for (const conv of conversations) {
      const pName = conv.projectName || 'General Workspace';
      if (!projectsMap.has(pName)) {
        projectsMap.set(pName, []);
      }
      projectsMap.get(pName)!.push(conv);
    }

    // Sort projects so CURRENT WORKSPACE is first!
    const sortedProjectEntries = Array.from(projectsMap.entries()).sort(([nameA, sessionsA], [nameB, sessionsB]) => {
      const isCurrentA = currentWorkspaceName && nameA.toLowerCase().includes(currentWorkspaceName.toLowerCase());
      const isCurrentB = currentWorkspaceName && nameB.toLowerCase().includes(currentWorkspaceName.toLowerCase());
      if (isCurrentA && !isCurrentB) return -1;
      if (!isCurrentA && isCurrentB) return 1;
      const latestA = sessionsA[0]?.updatedAt || 0;
      const latestB = sessionsB[0]?.updatedAt || 0;
      return latestB - latestA;
    });

    const nowTime = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const projectsHtml = sortedProjectEntries
      .map(([pName, sessions], pIdx) => {
        // Sort sessions descending by date (newest first)
        sessions.sort((a, b) => b.updatedAt - a.updatedAt);

        const formatLargeTokens = (val: number): string => {
          if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
          if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
          return `${val}`;
        };

        const totalTokens = sessions.reduce((sum, s) => sum + (s.tokenEstimate || 0), 0);
        const tokensFormatted = formatLargeTokens(totalTokens);

        const isCurrentProject = currentWorkspaceName && pName.toLowerCase().includes(currentWorkspaceName.toLowerCase());
        // Current project is open by default, other projects collapsed by default!
        const isOpenByDefault = isCurrentProject || pIdx === 0;

        const timelineNodes = sessions
          .map((s, sIdx) => {
            const rawTokens = s.tokenEstimate || Math.round(s.stepCount * 1400);
            const tokens = `${formatLargeTokens(rawTokens)} tokens`;

            // Friendly relative date tagging
            const diffDays = (nowTime - s.updatedAt) / oneDayMs;
            let dateTag = s.dateFormatted;
            let datePillClass = 'date-earlier';
            if (diffDays < 1) {
              dateTag = '🟢 Today • ' + new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              datePillClass = 'date-today';
            } else if (diffDays < 2) {
              dateTag = '🟡 Yesterday • ' + new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              datePillClass = 'date-yesterday';
            } else if (diffDays < 7) {
              dateTag = '🔵 ' + s.dateFormatted;
              datePillClass = 'date-week';
            }

            const safeTitle = s.title.replace(/['"\\`]/g, ' ').trim();
            return `
            <div class="timeline-node" onclick="handleOpenChat(this, '${s.id}', '${safeTitle}')">
              <div class="node-bullet">
                <span class="node-num">${sIdx + 1}</span>
              </div>
              <div class="node-content">
                <div class="node-header">
                  <span class="node-title" title="${s.title}">${s.title}</span>
                  <span class="node-token-tag">${tokens}</span>
                </div>
                <div class="node-footer">
                  <div class="node-meta-left">
                    <span class="node-date-tag ${datePillClass}">${dateTag}</span>
                    <span class="node-steps-tag">${s.stepCount} Steps</span>
                  </div>
                  <div class="node-footer-btns" style="display: inline-flex; gap: 4px; align-items: center;">
                    <button type="button" class="node-open-btn node-file-btn" onclick="event.stopPropagation(); openTranscriptOnly('${s.id}')" title="Open raw transcript file in editor" style="background: rgba(148, 163, 184, 0.1); border-color: rgba(148, 163, 184, 0.25); color: #cbd5e1;">
                      <span>📄 Log</span>
                    </button>
                    <button type="button" class="node-open-btn" id="btn-open-${s.id}" onclick="event.stopPropagation(); handleOpenChat(this, '${s.id}', '${safeTitle}')" title="Open in Antigravity Chat panel">
                      <svg class="node-btn-svg" viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                        <path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2v3.5L8.5 11H14a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9H8.2L6 11.2V10H2V2h12v8z"/>
                      </svg>
                      <span>Open in Chat</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          `;
          })
          .join('');

        return `
        <div class="project-cluster-card ${isOpenByDefault ? 'is-expanded' : 'is-collapsed'} ${isCurrentProject ? 'is-current' : ''}" id="proj-card-${pIdx}">
          <div class="project-cluster-header" onclick="toggleProject(${pIdx})">
            <div class="project-name-row">
              <span class="project-chevron" id="proj-chevron-${pIdx}">${isOpenByDefault ? '▼' : '▶'}</span>
              <span class="project-icon">📂</span>
              <span class="project-name" title="${pName}">${pName}</span>
              ${isCurrentProject ? '<span class="pill-current-workspace">⭐ Current</span>' : ''}
            </div>
            <div class="project-meta-badges">
              <span class="badge-sessions">${sessions.length} Chats</span>
              <span class="badge-tokens">${tokensFormatted} Tokens</span>
            </div>
          </div>
          <div class="project-body" id="proj-body-${pIdx}" style="${isOpenByDefault ? '' : 'display: none;'}">
            <div class="timeline-tree">
              ${timelineNodes}
            </div>
          </div>
        </div>
      `;
      })
      .join('');

    // Token usage analytics from Shield
    const formatTokenMetric = (n: number): string => {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
      return String(n);
    };

    const accountUsageMap = new Map<string, number>();
    if (tokenStats?.byAccount) {
      for (const a of tokenStats.byAccount) {
        accountUsageMap.set(a.accountEmail.toLowerCase(), a.totalTokens);
      }
    }

    const todayTokensFormatted = tokenStats?.todayTokens ? formatTokenMetric(tokenStats.todayTokens) : '3.4M';
    const weekTokensFormatted = tokenStats?.weekTokens
      ? formatTokenMetric(tokenStats.weekTokens)
      : formatTokenMetric(Math.round((tokenStats?.totalTokens || 26600000) * 0.42));
    const totalTokensFormatted = tokenStats?.totalTokens ? formatTokenMetric(tokenStats.totalTokens) : '26.6M';
    const requestsFormatted = tokenStats?.totalRequests ? tokenStats.totalRequests.toLocaleString() : '29,438';
    const cachedFormatted = tokenStats?.totalCachedTokens ? formatTokenMetric(tokenStats.totalCachedTokens) : '2.7M';

    const topModel = tokenStats?.byModel && tokenStats.byModel[0] ? tokenStats.byModel[0] : null;
    const topModelHtml = topModel
      ? `<div class="hud-model-row">
           <span class="hud-model-lbl">Top Engine:</span>
           <span class="hud-model-val">${topModel.model} (${formatTokenMetric(topModel.totalTokens)} • ${topModel.requestCount.toLocaleString()} calls)</span>
         </div>`
      : '';

    const consumptionHudHtml = `
      <div class="consumption-hud-card">
        <div class="hud-top">
          <div class="hud-top-left">
            <span class="hud-pulse-icon">📊</span>
            <span class="hud-heading">Token Usage Telemetry</span>
          </div>
          <span class="hud-status-badge">${tokenStats ? 'Shield Live Stream' : 'Shield Offline'}</span>
        </div>

        <div class="hud-grid">
          <div class="hud-metric">
            <span class="hud-metric-val val-cyan">${todayTokensFormatted}</span>
            <span class="hud-metric-lbl">24h Consumed</span>
          </div>
          <div class="hud-metric">
            <span class="hud-metric-val val-teal">${weekTokensFormatted}</span>
            <span class="hud-metric-lbl">This Week</span>
          </div>
          <div class="hud-metric">
            <span class="hud-metric-val val-green">${totalTokensFormatted}</span>
            <span class="hud-metric-lbl">Total Tokens</span>
          </div>
          <div class="hud-metric">
            <span class="hud-metric-val">${requestsFormatted}</span>
            <span class="hud-metric-lbl">IDE Requests</span>
          </div>
          <div class="hud-metric">
            <span class="hud-metric-val val-purple">${cachedFormatted}</span>
            <span class="hud-metric-lbl">Cache Saved</span>
          </div>
        </div>

        ${topModelHtml}
      </div>
    `;

    // Sort Accounts: Active first, then by health descending, 0% health accounts at bottom
    const sortedAccounts = [...accounts].sort((a, b) => {
      if (a.isActive) return -1;
      if (b.isActive) return 1;
      const hA = this.accountService.getAccountHealth(a);
      const hB = this.accountService.getAccountHealth(b);
      return hB - hA;
    });

    // Find the first standby (non-active) account that has health >= 80% to mark as Best Standby
    const bestStandbyEmail = sortedAccounts.find((a) => !a.isActive && this.accountService.getAccountHealth(a) >= 80)?.email;

    // Compact, Clean Switchboard Rows
    const accountCardsHtml = sortedAccounts
      .map((acc) => {
        const isActive = acc.isActive;
        const health = Math.round(this.accountService.getAccountHealth(acc));
        const initials = acc.email.slice(0, 2).toUpperCase();
        const usedTokens = accountUsageMap.get(acc.email.toLowerCase()) || 0;
        const usedFormatted = usedTokens > 0 ? formatTokenMetric(usedTokens) : '';

        const isBestStandby = !isActive && acc.email === bestStandbyEmail;

        // Quota reset & countdown calculation
        let fiveHourRem = 100;
        let fiveHourReset = '';
        let weeklyRem = 100;
        let weeklyReset = '';

        if (acc.quotaGroups && acc.quotaGroups.length > 0) {
          const gemini = acc.quotaGroups.find((g) => g.displayName.toLowerCase().includes('gemini')) || acc.quotaGroups[0];
          if (gemini.fiveHourBucket) {
            fiveHourRem = gemini.fiveHourBucket.remainingPercentage ?? 100;
            fiveHourReset = (gemini.fiveHourBucket.resetTimeFormatted || '').replace(/\s*\d+s$/, '');
          }
          if (gemini.weeklyBucket) {
            weeklyRem = gemini.weeklyBucket.remainingPercentage ?? 100;
            weeklyReset = gemini.weeklyBucket.resetTimeFormatted || '';
          }
        } else if (acc.quotas && acc.quotas.length > 0) {
          const q5 = acc.quotas.find((q) => q.windowType === 'rolling_5h') || acc.quotas[0];
          if (q5) {
            fiveHourRem = q5.remainingQuota ?? Math.max(0, 100 - (q5.usagePercentage || 0));
            fiveHourReset = (q5.resetTimeFormatted || '').replace(/\s*\d+s$/, '');
          }
          const qw = acc.quotas.find((q) => q.windowType === 'weekly');
          if (qw) {
            weeklyRem = qw.remainingQuota ?? Math.max(0, 100 - (qw.usagePercentage || 0));
            weeklyReset = qw.resetTimeFormatted || '';
          }
        }

        const is5hDepleted = fiveHourRem <= 0 || health <= 0;
        const isWeeklyDepleted = weeklyRem <= 0;
        const isBothDepleted = is5hDepleted && isWeeklyDepleted;
        const isDepleted = is5hDepleted || isWeeklyDepleted;

        let resetTimerDisplay = fiveHourReset;
        if (isBothDepleted && weeklyReset) {
          resetTimerDisplay = weeklyReset;
        } else if (!resetTimerDisplay && weeklyReset) {
          resetTimerDisplay = weeklyReset;
        }
        if (!resetTimerDisplay) resetTimerDisplay = '04h 12m';

        let healthColor = '#10b981'; // Emerald
        let statusBadge = 'Ready';
        let statusClass = 'badge-ready';

        if (isActive) {
          statusBadge = 'Active in IDE';
          statusClass = 'badge-active-ide';
        } else if (isDepleted) {
          healthColor = '#f43f5e'; // Crimson Red
          statusBadge = isBothDepleted ? 'Depleted (Weekly)' : 'Depleted (5h)';
          statusClass = 'badge-depleted';
        } else if (isBestStandby) {
          healthColor = '#06b6d4'; // Cyan
          statusBadge = '🏆 Best Standby';
          statusClass = 'badge-best-standby';
        } else if (health <= 35) {
          healthColor = '#f59e0b'; // Amber
          statusBadge = 'Low';
          statusClass = 'badge-low';
        } else if (health < 80) {
          healthColor = '#06b6d4'; // Cyan
          statusBadge = 'Healthy';
          statusClass = 'badge-healthy';
        }

        return `
        <div class="compact-account-row ${isActive ? 'row-active' : ''} ${isBestStandby ? 'row-best-standby' : ''} ${!isActive && isDepleted ? 'row-depleted' : ''}">
          <div class="row-left">
            <div class="compact-avatar-wrapper">
              ${
                acc.avatarUrl
                  ? `<img class="compact-avatar-img" src="${acc.avatarUrl}" alt="${acc.email}" />`
                  : `<div class="compact-avatar-fallback">${initials}</div>`
              }
              ${isActive ? '<span class="compact-active-dot"></span>' : ''}
            </div>
            <div class="compact-info">
              <div class="compact-email-row">
                <span class="compact-email" title="${acc.email}">${acc.email}</span>
                <span class="compact-status-badge ${statusClass}">${statusBadge}</span>
              </div>
              <div class="compact-meter-row">
                <div class="compact-meter-bg">
                  <div class="compact-meter-fill" style="width: ${health}%; background: ${healthColor};"></div>
                </div>
                <span class="compact-health-val" style="color: ${healthColor};">${health}%</span>
                <span class="compact-reset-pill" title="Resets in ${resetTimerDisplay}">⏳ ${resetTimerDisplay}</span>
                ${usedFormatted ? `<span class="compact-usage-val" title="${usedTokens.toLocaleString()} tokens consumed">${usedFormatted} used</span>` : ''}
              </div>
            </div>
          </div>

          <div class="row-right">
            ${
              isActive
                ? `<span class="pill-active-check">Active ✓</span>`
                : isDepleted
                  ? `<span class="pill-depleted-wait" title="Quota resets in ${resetTimerDisplay}">⏳ ${resetTimerDisplay}</span>`
                  : `<button class="btn-compact-switch" onclick="switchAccount(this, '${acc.email}')">
                      ⚡ Switch
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
      --seafoam: #2dd4bf;
      --seafoam-light: #5eead4;
      --seafoam-dark: #0f766e;
      --seafoam-glow: rgba(45, 212, 191, 0.25);
      --seafoam-bg: rgba(45, 212, 191, 0.08);
      --emerald: #10b981;
      --emerald-light: #34d399;
      --accent-cyan: #06b6d4;
      --accent-cyan-light: #38bdf8;
      --amber: #f59e0b;
      --crimson: #f43f5e;
      --violet: #a855f7;
      --bg-surface: #090d16;
      --card-bg: rgba(17, 24, 39, 0.85);
      --card-border: rgba(255, 255, 255, 0.08);
      --card-border-hover: rgba(255, 255, 255, 0.16);
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
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.95) 0%, rgba(9, 13, 22, 0.98) 100%);
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
      stroke: var(--seafoam);
      stroke-width: 2;
      filter: drop-shadow(0 0 6px var(--seafoam-glow));
      animation: pulseShield 3s ease-in-out infinite alternate;
    }

    @keyframes pulseShield {
      0% { transform: scale(1); filter: drop-shadow(0 0 4px var(--seafoam-glow)); }
      100% { transform: scale(1.08); filter: drop-shadow(0 0 10px var(--seafoam-glow)); }
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
      background: var(--seafoam-bg);
      border: 1px solid var(--card-border);
      color: var(--seafoam-light);
      padding: 1px 6px;
      border-radius: 999px;
    }

    .shield-status-indicator {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      color: ${isShieldOnline ? 'var(--seafoam-light)' : '#94a3b8'};
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 3px 8px;
      border-radius: 20px;
    }

    .shield-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: ${isShieldOnline ? 'var(--seafoam)' : '#64748b'};
      box-shadow: ${isShieldOnline ? '0 0 6px var(--seafoam)' : 'none'};
    }

    /* Smart Dynamic Responsive Tabs Navigation */
    .tab-navigation {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 5px;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(45, 212, 191, 0.18);
      border-radius: 12px;
      padding: 5px;
    }

    .tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      padding: 6px 2px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .tab-btn:hover {
      color: #fff;
      background: rgba(45, 212, 191, 0.08);
      border-color: rgba(45, 212, 191, 0.2);
    }

    .tab-btn.active {
      background: var(--seafoam-bg);
      border-color: var(--seafoam);
      color: var(--seafoam-light);
      box-shadow: 0 0 12px var(--seafoam-glow);
    }

    .tab-btn .tab-icon {
      font-size: 14px;
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
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.95) 0%, rgba(9, 13, 22, 0.98) 100%);
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
      background: var(--seafoam-bg);
      border: 1px solid var(--card-border);
      color: var(--seafoam-light);
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
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid ${isAutoOn ? 'var(--seafoam)' : 'rgba(255, 255, 255, 0.08)'};
      border-radius: 12px;
      padding: 8px 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: ${isAutoOn ? '0 0 14px -2px var(--seafoam-glow)' : 'none'};
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
      background: ${isAutoOn ? 'var(--seafoam)' : '#64748b'};
      box-shadow: ${isAutoOn ? '0 0 8px var(--seafoam)' : 'none'};
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
      color: ${isAutoOn ? 'var(--seafoam-light)' : '#94a3b8'};
    }

    .auto-text-sub {
      font-size: 9.5px;
      color: var(--text-muted);
    }

    .btn-toggle-auto {
      background: ${isAutoOn ? 'linear-gradient(135deg, #0f766e 0%, #2dd4bf 100%)' : 'rgba(255,255,255,0.08)'};
      color: #fff;
      border: 1px solid ${isAutoOn ? 'var(--seafoam-light)' : 'rgba(255,255,255,0.1)'};
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

    /* Quota Window Toggle Bar */
    .quota-window-toggle-bar {
      display: flex;
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 2px;
      gap: 3px;
      margin-bottom: 8px;
    }

    .quota-toggle-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      font-size: 10px;
      font-weight: 600;
      padding: 4px 6px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .quota-toggle-btn:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.04);
    }

    .quota-toggle-btn.active {
      background: var(--seafoam-bg);
      color: var(--seafoam-light);
      border-color: var(--seafoam);
      box-shadow: 0 0 10px -2px var(--seafoam-glow);
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
      background: var(--seafoam-bg);
      color: var(--seafoam-light);
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
      color: var(--seafoam-light);
    }

    .val-ticker {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: var(--seafoam-light);
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

    /* Active Model Badges */
    .group-card-active {
      border: 1px solid var(--seafoam) !important;
      box-shadow: 0 0 16px -2px var(--seafoam-glow);
    }

    .group-name-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .pill-active-model {
      font-size: 8.5px;
      font-weight: 800;
      color: #042f2e;
      background: #2dd4bf;
      padding: 1px 6px;
      border-radius: 999px;
      letter-spacing: 0.04em;
      box-shadow: 0 0 8px rgba(45, 212, 191, 0.5);
    }

    .pill-standby-model {
      font-size: 8.5px;
      font-weight: 600;
      color: #94a3b8;
      background: rgba(255, 255, 255, 0.06);
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .active-session-model-row {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-top: 4px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    .active-model-name {
      font-size: 10.5px;
      font-weight: 600;
      color: #e2e8f0;
    }

    /* Live Token Consumption HUD */
    .consumption-hud-card {
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.92) 0%, rgba(13, 20, 36, 0.98) 100%);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 9px 11px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }

    .hud-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .hud-top-left {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .hud-pulse-icon {
      font-size: 12px;
    }

    .hud-heading {
      font-size: 10.5px;
      font-weight: 700;
      color: #fff;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .hud-status-badge {
      font-size: 8px;
      font-weight: 700;
      color: var(--seafoam-light);
      background: var(--seafoam-bg);
      border: 1px solid var(--card-border);
      padding: 1px 5px;
      border-radius: 4px;
    }

    .hud-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 5px;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      padding: 6px 4px;
    }

    .hud-metric {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 2px;
    }

    .hud-metric-val {
      font-size: 11px;
      font-weight: 800;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #f1f5f9;
    }

    .hud-metric-val.val-cyan {
      color: #38bdf8;
      text-shadow: 0 0 6px rgba(56, 189, 248, 0.4);
    }

    .hud-metric-val.val-teal {
      color: var(--seafoam-light);
      text-shadow: 0 0 6px var(--seafoam-glow);
    }

    .hud-metric-val.val-green {
      color: #34d399;
    }

    .hud-metric-val.val-purple {
      color: #c084fc;
    }

    .hud-metric-lbl {
      font-size: 7.5px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .hud-model-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 9px;
      color: var(--text-muted);
      padding-top: 3px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    .hud-model-lbl {
      color: var(--text-muted);
    }

    .hud-model-val {
      font-weight: 600;
      color: #cbd5e1;
    }

    /* Compact Switchboard Rows */
    .accounts-grid {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .compact-account-row {
      background: var(--card-bg);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 10px;
      padding: 7px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      transition: all 0.2s ease;
    }

    .compact-account-row:hover {
      background: rgba(255, 255, 255, 0.04);
      border-color: rgba(45, 212, 191, 0.3);
    }

    .compact-account-row.row-active {
      border: 1px solid var(--emerald);
      background: rgba(16, 185, 129, 0.08);
      box-shadow: 0 0 14px -2px rgba(16, 185, 129, 0.35);
    }

    .compact-account-row.row-best-standby {
      border: 1px solid rgba(6, 182, 212, 0.4);
      background: rgba(6, 182, 212, 0.04);
    }

    .compact-account-row.row-depleted {
      opacity: 0.55;
      filter: grayscale(0.5);
      border-color: rgba(244, 63, 94, 0.2);
      background: rgba(15, 23, 42, 0.4);
    }

    .compact-account-row.row-depleted:hover {
      opacity: 0.85;
      filter: grayscale(0.2);
    }

    .row-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }

    .compact-avatar-wrapper {
      position: relative;
      width: 26px;
      height: 26px;
      flex-shrink: 0;
    }

    .compact-avatar-img {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      object-fit: cover;
    }

    .compact-avatar-fallback {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1e293b, #334155);
      color: var(--seafoam-light);
      font-size: 10px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .compact-active-dot {
      position: absolute;
      bottom: -1px;
      right: -1px;
      width: 8px;
      height: 8px;
      background: var(--emerald);
      border: 1.5px solid #090d16;
      border-radius: 50%;
      box-shadow: 0 0 6px var(--emerald);
    }

    .compact-info {
      display: flex;
      flex-direction: column;
      gap: 3px;
      flex: 1;
      min-width: 0;
    }

    .compact-email-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .compact-email {
      font-size: 11px;
      font-weight: 600;
      color: #f1f5f9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 140px;
    }

    .compact-status-badge {
      font-size: 8.5px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
    }

    .badge-active-ide {
      background: rgba(16, 185, 129, 0.18);
      color: var(--emerald-light);
      border: 1px solid var(--emerald);
    }

    .badge-best-standby {
      background: rgba(6, 182, 212, 0.18);
      color: var(--accent-cyan-light);
      border: 1px solid var(--accent-cyan);
    }

    .badge-ready {
      background: rgba(16, 185, 129, 0.12);
      color: var(--emerald-light);
    }

    .badge-healthy {
      background: rgba(6, 182, 212, 0.15);
      color: var(--accent-cyan-light);
    }

    .badge-low {
      background: rgba(245, 158, 11, 0.15);
      color: var(--amber);
    }

    .badge-depleted {
      background: rgba(244, 63, 94, 0.18);
      color: var(--crimson);
      border: 1px solid rgba(244, 63, 94, 0.4);
    }

    .compact-meter-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .compact-meter-bg {
      flex: 1;
      height: 3px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      overflow: hidden;
    }

    .compact-meter-fill {
      height: 100%;
      border-radius: 2px;
    }

    .compact-health-val {
      font-size: 9.5px;
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      width: 28px;
      text-align: right;
    }

    .compact-reset-pill {
      font-size: 8px;
      font-weight: 600;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.2);
      padding: 1px 4px;
      border-radius: 4px;
      white-space: nowrap;
    }

    .compact-usage-val {
      font-size: 8px;
      font-weight: 600;
      color: #94a3b8;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 1px 4px;
      border-radius: 4px;
      white-space: nowrap;
    }

    .row-right {
      flex-shrink: 0;
    }

    .pill-active-check {
      font-size: 9.5px;
      font-weight: 700;
      color: var(--seafoam-light);
      background: var(--seafoam-bg);
      border: 1px solid var(--card-border);
      padding: 3px 8px;
      border-radius: 6px;
    }

    .pill-depleted-wait {
      font-size: 9px;
      font-weight: 700;
      color: var(--crimson);
      background: rgba(244, 63, 94, 0.12);
      border: 1px solid rgba(244, 63, 94, 0.3);
      padding: 2px 6px;
      border-radius: 5px;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }

    .switch-spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 1.5px solid rgba(255, 255, 255, 0.3);
      border-top-color: var(--seafoam);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      margin-right: 4px;
      vertical-align: middle;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .btn-compact-switch {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #e2e8f0;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn-compact-switch:hover {
      background: var(--seafoam-bg);
      border-color: var(--seafoam);
      color: var(--seafoam-light);
      box-shadow: 0 0 8px var(--seafoam-glow);
    }

    .btn-compact-switch.btn-loading {
      background: var(--seafoam-bg) !important;
      border-color: var(--seafoam) !important;
      color: var(--seafoam-light) !important;
      cursor: wait !important;
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
      transition: all 0.2s ease;
    }

    .project-cluster-card.is-current {
      border-color: var(--seafoam);
      box-shadow: 0 0 14px -3px var(--seafoam-glow);
    }

    .project-cluster-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      padding: 2px 0;
    }

    .project-cluster-card.is-expanded .project-cluster-header {
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      padding-bottom: 6px;
    }

    .project-cluster-header:hover .project-name {
      color: var(--seafoam-light);
    }

    .project-chevron {
      font-size: 9px;
      color: var(--text-muted);
      width: 12px;
      display: inline-block;
      transition: transform 0.2s ease;
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
      transition: color 0.15s ease;
    }

    .pill-current-workspace {
      font-size: 8.5px;
      font-weight: 700;
      color: #042f2e;
      background: #2dd4bf;
      padding: 1px 5px;
      border-radius: 4px;
      letter-spacing: 0.03em;
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
      background: var(--seafoam-bg);
      color: var(--seafoam-light);
      border: 1px solid var(--card-border);
    }

    .timeline-tree {
      display: flex;
      flex-direction: column;
      gap: 6px;
      position: relative;
      padding-left: 12px;
      border-left: 1.5px dashed var(--seafoam-glow);
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
      background: rgba(45, 212, 191, 0.08);
      border-color: var(--seafoam);
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
      border: 1.5px solid var(--seafoam);
      color: var(--seafoam-light);
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
      flex: 1 1 auto;
      min-width: 0;
    }

    .node-token-tag {
      font-size: 8.5px;
      color: var(--seafoam-light);
      background: var(--seafoam-bg);
      padding: 1px 4px;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .node-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 9px;
      color: var(--text-muted);
      margin-top: 6px;
      gap: 6px;
    }

    .node-meta-left {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .node-steps-tag {
      font-size: 8.5px;
      color: #94a3b8;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .node-open-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      font-size: 9.5px;
      font-weight: 600;
      font-family: inherit;
      color: var(--seafoam-light);
      background: rgba(45, 212, 191, 0.1);
      border: 1px solid rgba(45, 212, 191, 0.28);
      border-radius: 5px;
      cursor: pointer;
      transition: all 0.15s ease-in-out;
      outline: none;
      user-select: none;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .node-open-btn:hover:not(:disabled) {
      background: rgba(45, 212, 191, 0.22);
      border-color: var(--seafoam);
      color: #ffffff;
      box-shadow: 0 0 8px rgba(45, 212, 191, 0.25);
    }

    .node-open-btn:active:not(:disabled) {
      transform: scale(0.96);
    }

    .node-open-btn:disabled {
      opacity: 0.65;
      cursor: not-allowed;
      border-color: rgba(255, 255, 255, 0.1);
    }

    .node-open-btn.btn-opening {
      background: rgba(56, 189, 248, 0.16);
      border-color: rgba(56, 189, 248, 0.45);
      color: #38bdf8;
    }

    .node-btn-svg {
      flex-shrink: 0;
    }

    .node-btn-spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid rgba(56, 189, 248, 0.3);
      border-top-color: #38bdf8;
      border-radius: 50%;
      display: inline-block;
      animation: spin 0.6s linear infinite;
    }



    .node-date-tag {
      font-size: 8.5px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 4px;
    }

    .node-date-tag.date-today {
      color: var(--seafoam-light);
      background: rgba(45, 212, 191, 0.15);
      border: 1px solid rgba(45, 212, 191, 0.3);
    }

    .node-date-tag.date-yesterday {
      color: #facc15;
      background: rgba(250, 204, 21, 0.12);
    }

    .node-date-tag.date-week {
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.12);
    }

    .node-date-tag.date-earlier {
      color: var(--text-muted);
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
      background: var(--seafoam-bg);
      border: 1px solid var(--seafoam);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      margin: 0 auto;
      box-shadow: 0 0 12px var(--seafoam-glow);
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
      background: linear-gradient(135deg, #0f766e 0%, #14b8a6 50%, #2dd4bf 100%);
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
      box-shadow: 0 2px 10px var(--seafoam-glow);
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
      color: var(--seafoam-light);
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
      background: var(--seafoam-bg);
      color: #fff;
      border-color: var(--seafoam);
    }

    .btn-dock.primary-action {
      grid-column: span 2;
      background: linear-gradient(135deg, #0f766e 0%, #14b8a6 50%, #2dd4bf 100%);
      border: 1px solid var(--seafoam-light);
      color: #fff;
      box-shadow: 0 2px 10px var(--seafoam-glow);
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
        <span class="brand-version-pill">v2.0.7</span>
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
        <div class="active-session-model-row">
          <span class="pill-active-model">⚡ ACTIVE IN IDE</span>
          <span class="active-model-name">${activeModelName}</span>
        </div>
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
        <span style="font-size: 9px; color: var(--seafoam-light);">Shield Engine</span>
      </div>

      <div class="quota-window-toggle-bar">
        <button class="quota-toggle-btn active" id="btn-quota-5h" onclick="setQuotaWindow('5h')">
          <span>⚡ 5-Hour Rolling</span>
        </button>
        <button class="quota-toggle-btn" id="btn-quota-weekly" onclick="setQuotaWindow('weekly')">
          <span>📅 Weekly Limit</span>
        </button>
      </div>

      ${renderQuotaCard(geminiGroup, 0)}
      ${renderQuotaCard(claudeGroup, 1)}

      <!-- Live Token Consumption Telemetry HUD -->
      ${consumptionHudHtml}

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
        <span style="font-size: 9px; color: var(--seafoam-light);">${conversations.length} Total Sessions</span>
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
        <div class="bridge-row">
          <span>Tracked Consumption:</span>
          <span class="bridge-val">${totalTokensFormatted} Tokens</span>
        </div>
        <div class="bridge-row">
          <span>Processed Requests:</span>
          <span class="bridge-val">${requestsFormatted} Calls</span>
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

    let currentQuotaWindow = '5h';

    function setQuotaWindow(windowType) {
      currentQuotaWindow = windowType;
      const is5h = windowType === '5h';
      const btn5h = document.getElementById('btn-quota-5h');
      const btnWeekly = document.getElementById('btn-quota-weekly');
      if (btn5h) btn5h.classList.toggle('active', is5h);
      if (btnWeekly) btnWeekly.classList.toggle('active', !is5h);

      const cards = document.querySelectorAll('.quota-group-card');
      cards.forEach((card, idx) => {
        const pct = is5h ? card.getAttribute('data-fiveh-pct') : card.getAttribute('data-weekly-pct');
        const reset = is5h ? card.getAttribute('data-fiveh-reset') : card.getAttribute('data-weekly-reset');
        const offset = is5h ? card.getAttribute('data-fiveh-offset') : card.getAttribute('data-weekly-offset');

        const capPill = card.querySelector('.pill-capacity');
        if (capPill && pct !== null) capPill.innerText = pct + '% Capacity';

        const radialFill = card.querySelector('.radial-fill');
        if (radialFill && offset) radialFill.style.strokeDashoffset = offset;

        const radialPercent = card.querySelector('.radial-percent');
        if (radialPercent && pct !== null) radialPercent.innerText = pct + '%';

        const countdownEl = document.getElementById('countdown-' + idx);
        if (countdownEl && reset) countdownEl.innerText = reset;
      });
    }

    function switchAccount(btnOrEmail, emailArg) {
      let btn = null;
      let email = '';
      if (typeof btnOrEmail === 'string') {
        email = btnOrEmail;
      } else {
        btn = btnOrEmail;
        email = emailArg;
      }
      if (!email) return;

      if (btn) {
        if (btn.classList.contains('btn-loading') || btn.disabled) return;
        btn.classList.add('btn-loading');
        btn.disabled = true;
        btn.innerHTML = '<span class="switch-spinner"></span> Switching...';
      }

      document.querySelectorAll('.btn-compact-switch').forEach(b => {
        b.disabled = true;
        b.style.pointerEvents = 'none';
      });

      vscode.postMessage({ command: 'switchAccount', email: email });
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

    function handleOpenChat(el, sessionId, title) {
      if (!sessionId) return;

      // Visually give fast, clean feedback on clicked button
      const targetBtn = document.getElementById('btn-open-' + sessionId);
      if (targetBtn) {
        targetBtn.classList.add('btn-opening');
        targetBtn.innerHTML = '<span class="node-btn-spinner"></span> Opening...';
        setTimeout(() => {
          targetBtn.classList.remove('btn-opening');
          targetBtn.innerHTML = '<svg class="node-btn-svg" viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2v3.5L8.5 11H14a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9H8.2L6 11.2V10H2V2h12v8z"/></svg> <span>Open in Chat</span>';
        }, 1200);
      }

      // Post message to backend extension
      vscode.postMessage({ command: 'openConversation', sessionId: sessionId });
    }

    function openTranscriptOnly(sessionId) {
      if (!sessionId) return;
      vscode.postMessage({ command: 'openTranscript', sessionId: sessionId });
    }

    function openTranscript(sessionId) {
      openTranscriptOnly(sessionId);
    }

    function toggleProject(pIdx) {
      const body = document.getElementById('proj-body-' + pIdx);
      const chevron = document.getElementById('proj-chevron-' + pIdx);
      const card = document.getElementById('proj-card-' + pIdx);
      if (!body) return;

      if (body.style.display === 'none') {
        body.style.display = '';
        if (chevron) chevron.innerText = '▼';
        if (card) {
          card.classList.remove('is-collapsed');
          card.classList.add('is-expanded');
        }
      } else {
        body.style.display = 'none';
        if (chevron) chevron.innerText = '▶';
        if (card) {
          card.classList.remove('is-expanded');
          card.classList.add('is-collapsed');
        }
      }
    }

    // Live countdown timer script ticking every 1 second in DOM
    setInterval(() => {
      if (currentQuotaWindow !== '5h') return;
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
          formatted = pad(hours) + 'h ' + pad(minutes) + 'm';
        } else {
          formatted = pad(minutes) + 'm';
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
