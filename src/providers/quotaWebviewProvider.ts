import * as vscode from 'vscode';
import * as path from 'path';
import { QuotaService } from '../services/quotaService';
import { AccountService } from '../services/accountService';
import { AutoSwitchService } from '../services/autoSwitchService';
import { ConversationService } from '../services/conversationService';
import { Account, ModelQuota, QuotaGroup, ConversationSession, TokenUsageStats } from '../types';
import { ShieldBridge } from '../bridge/shieldBridge';
import { LanguageServerClient, ActiveChatModelsResult } from '../bridge/languageServerClient';
import { TelegramRemoteService } from '../services/telegramRemoteService';
import { AutoApprovePolicyService } from '../services/autoApprovePolicyService';
import { MobileTunnelService } from '../services/mobileTunnelService';
import { generateQrSvg } from '../utils/qrCode';

function escapeHtmlAttr(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class QuotaWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravity.views.quota';
  private _view?: vscode.WebviewView;
  private _activeTab: string = 'overview';
  private _isSearchFocused = false;
  private _lastContentSearchQuery = '';
  private _lastTitleSearchQuery = '';

  private isUpdating = false;
  private updateDebounceTimer?: NodeJS.Timeout;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly quotaService: QuotaService,
    private readonly accountService: AccountService,
    private readonly autoSwitchService: AutoSwitchService,
    private readonly conversationService: ConversationService,
    private readonly telegramService?: TelegramRemoteService,
    private readonly autoApproveService?: AutoApprovePolicyService,
    private readonly mobileTunnelService?: MobileTunnelService
  ) {
    this.quotaService.onDidChangeQuotas(() => this.scheduleWebviewUpdate());
    this.accountService.onDidChangeAccounts(() => this.scheduleWebviewUpdate());
    this.autoSwitchService.onDidChangeStatus(() => this.scheduleWebviewUpdate());
    this.conversationService.onDidChangeConversations(() => this.scheduleWebviewUpdate());
  }

  public scheduleWebviewUpdate(): void {
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
    }
    this.updateDebounceTimer = setTimeout(() => {
      this.updateWebview();
    }, 120);
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

    // Immediately render instant local view with in-memory accounts and quotas (Zero loading lag)
    this.renderInstantView();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'tabChanged':
          if (message.tab && typeof message.tab === 'string') {
            this._activeTab = message.tab;
          }
          break;
        case 'searchStateChanged':
          if (typeof message.contentQuery === 'string') {
            this._lastContentSearchQuery = message.contentQuery.trim();
          }
          if (typeof message.titleQuery === 'string') {
            this._lastTitleSearchQuery = message.titleQuery.trim();
          }
          if (typeof message.isFocused === 'boolean') {
            this._isSearchFocused = message.isFocused;
          }
          if (!this._lastContentSearchQuery && !this._lastTitleSearchQuery && !this._isSearchFocused) {
            this.scheduleWebviewUpdate();
          }
          break;
        case 'refresh':
          await this.accountService.reloadFromDiskSilently();
          this.quotaService.notifyQuotasUpdated();
          await this.autoSwitchService.evaluateQuotasAndRotateIfNeeded();
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
        case 'verifyInShield':
          if (message.email) {
            vscode.window.showWarningMessage(
              `⚠️ Account ${message.email} requires Google identity verification. Please open Antigravity Shield and complete verification.`,
              'Sync with Shield'
            ).then((action) => {
              if (action === 'Sync with Shield') {
                this.accountService.syncFromShield().then(() => this.updateWebview());
              }
            });
          }
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
        case 'saveTelegramConfig':
          if (this.telegramService && message.config) {
            await this.telegramService.saveConfig(message.config);
            if (!message.silent) {
              vscode.window.showInformationMessage('Antigravity Telegram Remote configuration saved!');
              this.scheduleWebviewUpdate();
            }
          }
          break;
        case 'testTelegramAlert':
          if (this.telegramService) {
            const res = await this.telegramService.sendTestNotification();
            if (res.success) {
              vscode.window.showInformationMessage('✅ ' + res.message);
            } else {
              vscode.window.showErrorMessage('❌ ' + res.message);
            }
            this.scheduleWebviewUpdate();
          }
          break;
        case 'generatePairingCode':
          if (this.telegramService) {
            const pairInfo = await this.telegramService.generatePairingCode();
            vscode.window.showInformationMessage(`Pairing Code: ${pairInfo.code}. Send /pair ${pairInfo.code} to your Telegram bot.`);
            this.scheduleWebviewUpdate();
          }
          break;
        case 'saveAutoApprovePolicy':
          if (this.autoApproveService && message.policy) {
            await this.autoApproveService.saveConfig(message.policy);
            vscode.window.showInformationMessage('Agent Auto-Approve Policies updated!');
            this.scheduleWebviewUpdate();
          }
          break;
        case 'resetAutoApprovePolicy':
          if (this.autoApproveService) {
            await this.autoApproveService.resetDefaults();
            vscode.window.showInformationMessage('Agent Auto-Approve Policies reset to defaults.');
            this.scheduleWebviewUpdate();
          }
          break;
        case 'startCloudflareTunnel':
          try {
            vscode.window.showInformationMessage('🚀 Launching Cloudflare Tunnel & Opening Mobile View...');
            const tunnelService = this.mobileTunnelService || MobileTunnelService.getInstance();
            const res = await tunnelService.startSmartTunnelAndOpenBrowser();
            if (res.success && res.url) {
              vscode.window.showInformationMessage(`✅ Cloudflare Live Tunnel: ${res.url}`);
              const qrSvg = generateQrSvg(res.magicLink || res.url, 130);
              if (this._view) {
                this._view.webview.postMessage({
                  command: 'tunnelStateChanged',
                  isRunning: true,
                  url: res.url,
                  magicLink: res.magicLink,
                  qrSvg: qrSvg
                });
              }
            } else {
              vscode.window.showErrorMessage(`❌ Tunnel Launch Failed: ${res.error || 'Unknown error'}`);
              if (this._view) {
                this._view.webview.postMessage({
                  command: 'tunnelStateChanged',
                  isRunning: false,
                  error: res.error
                });
              }
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to start Cloudflare tunnel: ${err?.message || err}`);
            if (this._view) {
              this._view.webview.postMessage({
                command: 'tunnelStateChanged',
                isRunning: false,
                error: err?.message || String(err)
              });
            }
          }
          break;
        case 'stopCloudflareTunnel':
          try {
            const tunnelService = this.mobileTunnelService || MobileTunnelService.getInstance();
            await tunnelService.stopTunnel();
            vscode.window.showInformationMessage('🛑 Cloudflare Tunnel stopped.');
            if (this._view) {
              this._view.webview.postMessage({
                command: 'tunnelStateChanged',
                isRunning: false,
                url: '',
                magicLink: '',
                qrSvg: ''
              });
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to stop tunnel: ${err?.message || err}`);
          }
          break;
        case 'sendTunnelLinkToTelegram':
          if (this.telegramService) {
            const config = this.telegramService.getConfig();
            const link = this.telegramService.getMagicLink(config.cloudflareTunnelUrl);
            const msg = `🌐 <b>Antigravity Shield Live Mobile View</b>\n\n` +
              `📱 <b>Click below to open the real-time chat view on your phone:</b>\n\n` +
              `<code>${link}</code>`;
            const keyboard = {
              inline_keyboard: [
                [{ text: '🚀 Open Mobile View', url: link }]
              ]
            };
            const sent = await this.telegramService.sendTelegramMessage(msg, { reply_markup: keyboard });
            if (sent.success) {
              vscode.window.showInformationMessage('✅ Mobile Magic Link sent to your Telegram topic/group!');
            } else {
              vscode.window.showErrorMessage(`❌ Failed to send link: ${sent.error}`);
            }
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
        case 'autoRecoverChats':
          await this.conversationService.autoRecoverInterruptedSessions(false);
          this.updateWebview();
          break;
        case 'getConversationPreview':
          if (message.sessionId) {
            try {
              const preview = await this.conversationService.getConversationPreview(message.sessionId);
              if (this._view) {
                this._view.webview.postMessage({
                  command: 'conversationPreviewData',
                  data: preview,
                });
              }
            } catch (err: any) {
              if (this._view) {
                this._view.webview.postMessage({
                  command: 'conversationPreviewData',
                  data: { sessionId: message.sessionId, error: String(err?.message || err) },
                });
              }
            }
          }
          break;
        case 'openBrainFolder':
          if (message.sessionId) {
            await this.conversationService.openBrainFolder(message.sessionId);
          }
          break;
        case 'openArtifact':
          if (message.filePath) {
            await this.conversationService.openArtifact(message.filePath);
          }
          break;
        case 'searchContent':
          if (typeof message.query === 'string') {
            const results = await this.conversationService.searchConversationContent(
              message.query,
              message.scope || 'workspace'
            );
            if (this._view) {
              this._view.webview.postMessage({
                command: 'contentSearchResults',
                query: message.query,
                scope: message.scope,
                results,
              });
            }
          }
          break;
      }
    });

    this.updateWebview();
  }

  private renderInstantView(): void {
    if (!this._view) return;
    try {
      const activeAccount = this.accountService.getActiveAccount();
      const accounts = this.accountService.getAccounts();
      const autoSwitchStatus = this.autoSwitchService.getStatus();
      const quotas = activeAccount
        ? this.quotaService.getAccountQuotas(activeAccount)
        : (accounts.length > 0 ? this.quotaService.getAccountQuotas(accounts[0]) : []);
      const allConversations = this.conversationService.getCachedSessions();
      const workspaceConversations = allConversations;
      const isShieldOnline = ShieldBridge.getInstance().isLastKnownOnline();
      const currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const currentWorkspaceName =
        vscode.workspace.name ||
        (currentWorkspaceFolder ? path.basename(currentWorkspaceFolder) : '');

      this._view.webview.html = this.renderHtml(
        activeAccount || accounts[0],
        quotas,
        accounts,
        autoSwitchStatus,
        allConversations,
        workspaceConversations,
        isShieldOnline,
        currentWorkspaceName,
        null,
        'Gemini 3.8 Flash (Medium)',
        this._activeTab
      );
    } catch {
      if (this._view) {
        this._view.webview.html = this.renderLoadingSkeleton();
      }
    }
  }

  public async updateWebview(): Promise<void> {
    if (!this._view) {
      return;
    }
    if (this.isUpdating) {
      return;
    }
    // Prevent destroying the DOM while the user is actively focused, on remote tab, or searching
    if (this._isSearchFocused || this._activeTab === 'remote' || ((this._activeTab === 'history' || this._activeTab === 'chats') && (this._lastContentSearchQuery || this._lastTitleSearchQuery))) {
      return;
    }
    this.isUpdating = true;

    try {
      const activeAccount = this.accountService.getActiveAccount();
      const accounts = this.accountService.getAccounts();
      const autoSwitchStatus = this.autoSwitchService.getStatus();

      const quotas = await this.quotaService.getActiveQuotas().catch(() => []);

      const [
        allConversations,
        isShieldOnline,
        tokenStats,
      ] = await Promise.all([
        Promise.race([
          this.conversationService.getConversations(),
          new Promise<ConversationSession[]>((res) =>
            setTimeout(() => res(this.conversationService.getCachedSessions()), 2500)
          ),
        ]).catch(() => this.conversationService.getCachedSessions()),
        Promise.race([
          ShieldBridge.getInstance().isShieldOnline(),
          new Promise<boolean>((res) => setTimeout(() => res(ShieldBridge.getInstance().isLastKnownOnline()), 400))
        ]).catch(() => false),
        Promise.race([
          ShieldBridge.getInstance().getTokenStats(),
          new Promise<TokenUsageStats | null>((res) => setTimeout(() => res(null), 600))
        ]).catch(() => null),
      ]);

      // Detect currently open workspace in VS Code / Antigravity IDE
      const currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const currentWorkspaceName =
        vscode.workspace.name ||
        (currentWorkspaceFolder ? path.basename(currentWorkspaceFolder) : '');

      const normCurrentFolder = currentWorkspaceFolder ? path.normalize(currentWorkspaceFolder).toLowerCase() : '';
      const normCurrentName = currentWorkspaceName ? currentWorkspaceName.toLowerCase() : '';

      const workspaceConversations = allConversations.filter((s) => {
        if (!normCurrentFolder && !normCurrentName) return true;
        if (s.workspacePath) {
          const normWs = path.normalize(s.workspacePath).toLowerCase();
          if (
            normWs === normCurrentFolder ||
            normWs.startsWith(normCurrentFolder + path.sep) ||
            normCurrentFolder.startsWith(normWs + path.sep)
          ) {
            return true;
          }
        }
        if (s.projectName && normCurrentName && s.projectName.toLowerCase() === normCurrentName) {
          return true;
        }
        return false;
      });

      let activeModels: ActiveChatModelsResult = {
        geminiModel: 'Gemini 3.8 Flash (Medium)',
        claudeModel: 'Claude Sonnet 4.6 (Thinking)',
        isClaudeActive: false,
        activeModelName: 'Gemini 3.8 Flash (Medium)',
      };
      try {
        activeModels = await Promise.race([
          LanguageServerClient.getInstance().getActiveChatModels(
            workspaceConversations[0]?.id || allConversations[0]?.id
          ),
          new Promise<ActiveChatModelsResult>((_, reject) => setTimeout(() => reject(new Error('timeout')), 800))
        ]);
      } catch {}

      this._view.webview.html = this.renderHtml(
        activeAccount || accounts[0],
        quotas,
        accounts,
        autoSwitchStatus,
        allConversations,
        workspaceConversations,
        isShieldOnline,
        currentWorkspaceName,
        tokenStats,
        activeModels.activeModelName,
        this._activeTab,
        activeModels
      );
    } catch (err: any) {
      console.error('[QuotaWebviewProvider] Error updating webview:', err);
      if (this._view) {
        this._view.webview.html = this.renderErrorFallback(err?.message || String(err));
      }
    } finally {
      this.isUpdating = false;
    }
  }

  private renderHtml(
    activeAccount: Account | undefined,
    quotas: ModelQuota[],
    accounts: Account[],
    autoSwitchStatus: { enabled: boolean; thresholdPercent: number; cooldownMinutes: number },
    allConversations: ConversationSession[],
    workspaceConversations: ConversationSession[],
    isShieldOnline: boolean,
    currentWorkspaceName: string,
    tokenStats: TokenUsageStats | null,
    activeModelName: string,
    activeTab: string = 'overview',
    activeModels?: ActiveChatModelsResult,
    savedContentQuery: string = this._lastContentSearchQuery,
    savedTitleQuery: string = this._lastTitleSearchQuery
  ): string {
    const activeEmail = activeAccount ? activeAccount.email : 'No active account';
    const activeTier = activeAccount ? activeAccount.tier || 'Google AI Pro' : 'Free';
    const activeHealth = activeAccount ? Math.round(this.accountService.getAccountHealth(activeAccount)) : 0;
    const isAutoOn = autoSwitchStatus.enabled;
    const geminiModel = activeModels?.geminiModel || activeModelName || 'Gemini 3.8 Flash (Medium)';
    const claudeModel = activeModels?.claudeModel || 'Claude Sonnet 4.6 (Thinking)';
    const isClaudeActive = activeModels?.isClaudeActive || false;
    const primaryModel = isClaudeActive ? claudeModel : geminiModel;
    const secondaryModel = isClaudeActive ? geminiModel : claudeModel;
    const extensionVersion =
      vscode.extensions.getExtension('antigravity-hub.antigravity-toolkit')?.packageJSON?.version || '2.3.0';

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
        description: 'Gemini 3.8 Flash, Pro & Thinking',
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
                  (isGemini && !isClaudeActive) || (!isGemini && isClaudeActive)
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

    const nowTime = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const formatLargeTokens = (val: number): string => {
      if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
      if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
      return `${val}`;
    };

    const renderTimelineNodes = (sessionList: ConversationSession[]) => {
      const cleanList = sessionList.filter(
        (s) => s && s.title && !s.title.toLowerCase().startsWith('session ')
      );
      return cleanList
        .map((s, sIdx) => {
          const rawTokens = s.tokenEstimate || Math.round(s.stepCount * 1400);
          const tokens = `${formatLargeTokens(rawTokens)} tokens`;

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

          const cleanNodeTitle = s.title.replace(/[\r\n\t]+/g, ' ').trim();
          const escapedTitle = cleanNodeTitle
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

          return `
          <div class="timeline-node" data-session-id="${s.id}" data-title="${escapedTitle.toLowerCase()}" onclick="handleOpenChat(this, '${s.id}')">
            <div class="node-bullet">
              <span class="node-num">${sIdx + 1}</span>
            </div>
            <div class="node-content">
              <div class="node-header">
                <span class="node-title" title="${escapedTitle}" data-original-title="${escapedTitle}">${escapedTitle}</span>
                <span class="node-token-tag">${tokens}</span>
              </div>
              <div class="node-footer">
                <div class="node-meta-left">
                  <span class="node-date-tag ${datePillClass}">${dateTag}</span>
                  <span class="node-steps-tag">${s.stepCount} Steps</span>
                </div>
                <div class="node-footer-btns" style="display: inline-flex; gap: 4px; align-items: center;">
                  <button type="button" class="node-open-btn node-preview-btn" onclick="event.stopPropagation(); previewSession('${s.id}')" title="Preview conversation & artifacts in modal" style="background: rgba(56, 189, 248, 0.12); border-color: rgba(56, 189, 248, 0.35); color: #38bdf8;">
                    <span>👁️ Preview</span>
                  </button>
                  <button type="button" class="node-open-btn" id="btn-open-${s.id}" onclick="event.stopPropagation(); handleOpenChat(this, '${s.id}')" title="Open in Antigravity Chat panel">
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
    };

    // 1. Workspace specific timeline
    const cleanWorkspaceConversations = workspaceConversations.filter(
      (s) => s && s.title && !s.title.toLowerCase().startsWith('session ')
    );
    const workspaceTimelineHtml =
      cleanWorkspaceConversations.length > 0
        ? `<div class="timeline-tree">${renderTimelineNodes(cleanWorkspaceConversations)}</div>`
        : `<div style="opacity:0.65; text-align:center; padding:18px 8px; font-size:11px;">No chats recorded for workspace <b>${currentWorkspaceName || 'Current'}</b></div>`;

    // 2. Group All Conversations by Project
    const projectsMap = new Map<string, ConversationSession[]>();
    for (const conv of allConversations) {
      if (!conv || !conv.title || conv.title.toLowerCase().startsWith('session ')) continue;
      const pName = conv.projectName || 'General';
      if (!projectsMap.has(pName)) {
        projectsMap.set(pName, []);
      }
      projectsMap.get(pName)!.push(conv);
    }

    // Sort projects so CURRENT WORKSPACE is first, followed by latest activity!
    const sortedProjectEntries = Array.from(projectsMap.entries()).sort(([nameA, sessionsA], [nameB, sessionsB]) => {
      const isCurrentA = currentWorkspaceName && nameA.toLowerCase() === currentWorkspaceName.toLowerCase();
      const isCurrentB = currentWorkspaceName && nameB.toLowerCase() === currentWorkspaceName.toLowerCase();
      if (isCurrentA && !isCurrentB) return -1;
      if (!isCurrentA && isCurrentB) return 1;
      const latestA = Math.max(...sessionsA.map((s) => s.updatedAt || 0), 0);
      const latestB = Math.max(...sessionsB.map((s) => s.updatedAt || 0), 0);
      return latestB - latestA;
    });

    const projectsHtml = sortedProjectEntries
      .map(([pName, sessions], pIdx) => {
        sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        const totalTokens = sessions.reduce((sum, s) => sum + (s.tokenEstimate || 0), 0);
        const tokensFormatted = formatLargeTokens(totalTokens);
        const isCurrentProject = currentWorkspaceName && pName.toLowerCase() === currentWorkspaceName.toLowerCase();
        const isOpenByDefault = isCurrentProject || pIdx === 0;

        return `
        <div class="project-cluster-card ${isOpenByDefault ? 'is-expanded' : 'is-collapsed'} ${isCurrentProject ? 'is-current' : ''}" id="proj-card-${pIdx}" data-project-name="${pName.toLowerCase()}">
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
              ${renderTimelineNodes(sessions)}
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

    // Sort Accounts: Active first, then usable standby accounts sorted by health descending,
    // and unusable (blocked/disabled) accounts at the bottom
    const sortedAccounts = [...accounts].sort((a, b) => {
      if (a.isActive) return -1;
      if (b.isActive) return 1;
      const usableA = this.accountService.isAccountUsable(a);
      const usableB = this.accountService.isAccountUsable(b);
      if (usableA && !usableB) return -1;
      if (!usableA && usableB) return 1;
      const hA = this.accountService.getAccountHealth(a);
      const hB = this.accountService.getAccountHealth(b);
      return hB - hA;
    });

    // Find the first standby (non-active) usable account that has health >= 80% to mark as Best Standby
    const bestStandbyEmail = sortedAccounts.find(
      (a) => !a.isActive && this.accountService.isAccountUsable(a) && this.accountService.getAccountHealth(a) >= 80
    )?.email;

    // Warning Banner if Active Account in IDE is blocked or disabled in Shield
    let activeAccountAlertHtml = '';
    if (activeAccount && !this.accountService.isAccountUsable(activeAccount)) {
      const isBlocked = Boolean(activeAccount.validationBlocked);
      const alertTitle = isBlocked ? 'Google Verification Required' : 'Active Account Disabled in Shield';
      const alertDesc = isBlocked
        ? `Account <strong>${activeAccount.email}</strong> requires identity verification in Google. Please open Antigravity Shield to verify, or switch to an eligible standby account.`
        : `Account <strong>${activeAccount.email}</strong> was turned off/disabled in Antigravity Shield. Requests will be rejected by the proxy.`;

      activeAccountAlertHtml = `
        <div class="active-alert-box ${isBlocked ? 'alert-warning' : 'alert-danger'}">
          <span class="alert-icon">⚠️</span>
          <div class="alert-msg">
            <div class="alert-title">${alertTitle}</div>
            <div>${alertDesc}</div>
          </div>
        </div>
      `;
    }

    // Compact, Clean Switchboard Rows
    const accountCardsHtml = sortedAccounts
      .map((acc) => {
        const isActive = acc.isActive;
        const isUsable = this.accountService.isAccountUsable(acc);
        const isBlocked = Boolean(acc.validationBlocked);
        const isDisabled = Boolean(acc.disabled || acc.proxyDisabled);
        const isForbidden = Boolean(acc.isForbidden);
        const health = Math.round(this.accountService.getAccountHealth(acc));
        const initials = acc.email.slice(0, 2).toUpperCase();
        const usedTokens = accountUsageMap.get(acc.email.toLowerCase()) || 0;
        const usedFormatted = usedTokens > 0 ? formatTokenMetric(usedTokens) : '';

        const isBestStandby = !isActive && isUsable && acc.email === bestStandbyEmail;

        // Quota reset & countdown calculation
        let fiveHourRem = 100;
        let fiveHourReset = '';
        let weeklyRem = 100;
        let weeklyReset = '';
        let fiveHourResetMs = 0;
        let weeklyResetMs = 0;

        if (acc.quotaGroups && acc.quotaGroups.length > 0) {
          const gemini = acc.quotaGroups.find((g) => g.displayName.toLowerCase().includes('gemini')) || acc.quotaGroups[0];
          if (gemini.fiveHourBucket) {
            fiveHourRem = gemini.fiveHourBucket.remainingPercentage ?? 100;
            fiveHourReset = (gemini.fiveHourBucket.resetTimeFormatted || '').replace(/\s*\d+s$/, '');
            fiveHourResetMs = gemini.fiveHourBucket.resetTimeMs || 0;
          }
          if (gemini.weeklyBucket) {
            weeklyRem = gemini.weeklyBucket.remainingPercentage ?? 100;
            weeklyReset = gemini.weeklyBucket.resetTimeFormatted || '';
            weeklyResetMs = gemini.weeklyBucket.resetTimeMs || 0;
          }
        } else if (acc.quotas && acc.quotas.length > 0) {
          const q5 = acc.quotas.find((q) => q.windowType === 'rolling_5h') || acc.quotas[0];
          if (q5) {
            fiveHourRem = q5.remainingQuota ?? Math.max(0, 100 - (q5.usagePercentage || 0));
            fiveHourReset = (q5.resetTimeFormatted || '').replace(/\s*\d+s$/, '');
            fiveHourResetMs = q5.resetTimeMs || 0;
          }
          const qw = acc.quotas.find((q) => q.windowType === 'weekly');
          if (qw) {
            weeklyRem = qw.remainingQuota ?? Math.max(0, 100 - (qw.usagePercentage || 0));
            weeklyReset = qw.resetTimeFormatted || '';
            weeklyResetMs = qw.resetTimeMs || 0;
          }
        }

        const is5hDepleted = fiveHourRem <= 0;
        const isWeeklyDepleted = weeklyRem <= 0;
        const isBothDepleted = is5hDepleted && isWeeklyDepleted;
        const isDepleted = !isBlocked && !isDisabled && !isForbidden && (is5hDepleted || isWeeklyDepleted);

        let targetResetMs = 0;
        let resetTimerDisplay = '';

        if (fiveHourRem < 100 && fiveHourReset) {
          resetTimerDisplay = fiveHourReset;
          targetResetMs = fiveHourResetMs;
        } else if (weeklyRem <= 0 && weeklyReset) {
          resetTimerDisplay = weeklyReset;
          targetResetMs = weeklyResetMs;
        } else if (fiveHourReset) {
          resetTimerDisplay = fiveHourReset;
          targetResetMs = fiveHourResetMs;
        } else if (weeklyReset) {
          resetTimerDisplay = weeklyReset;
          targetResetMs = weeklyResetMs;
        }
        if (!resetTimerDisplay) {
          resetTimerDisplay = fiveHourRem >= 100 ? 'Ready' : '';
        }

        let healthColor = '#10b981'; // Emerald
        let statusBadge = 'Ready';
        let statusClass = 'badge-ready';

        if (isActive) {
          if (isBlocked) {
            statusBadge = 'Active (⚠️ Verify)';
            statusClass = 'badge-blocked-orange';
            healthColor = '#f59e0b';
          } else if (isDisabled) {
            statusBadge = 'Active (Off in Shield)';
            statusClass = 'badge-shield-disabled';
            healthColor = '#64748b';
          } else {
            statusBadge = 'Active in IDE';
            statusClass = 'badge-active-ide';
          }
        } else if (isBlocked) {
          healthColor = '#f59e0b'; // Amber
          statusBadge = '⚠️ Verify in Shield';
          statusClass = 'badge-blocked-orange';
        } else if (isDisabled) {
          healthColor = '#64748b'; // Slate Gray
          statusBadge = acc.disabled ? 'Disabled' : 'Proxy Off';
          statusClass = 'badge-shield-disabled';
        } else if (isForbidden) {
          healthColor = '#f43f5e';
          statusBadge = 'Forbidden 403';
          statusClass = 'badge-depleted';
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

        const meterDisplayWidth = isUsable ? health : 0;
        const meterColor = isUsable ? healthColor : (isBlocked ? '#f59e0b' : '#64748b');

        return `
        <div class="compact-account-row ${isActive ? 'row-active' : ''} ${isBestStandby ? 'row-best-standby' : ''} ${isBlocked ? 'row-blocked' : ''} ${isDisabled ? 'row-disabled' : ''} ${!isActive && isDepleted ? 'row-depleted' : ''}">
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
                  <div class="compact-meter-fill" style="width: ${meterDisplayWidth}%; background: ${meterColor};"></div>
                </div>
                <span class="compact-health-val" style="color: ${meterColor};">${isUsable ? health + '%' : (isBlocked ? '⚠️' : 'Off')}</span>
                ${
                  isBlocked
                    ? `<span class="compact-reset-pill pill-blocked" title="${acc.validationBlockedReason || 'Verification Required in Shield'}">⚠️ Verification Required</span>`
                    : isDisabled
                    ? `<span class="compact-reset-pill pill-disabled" title="${acc.proxyDisabledReason || 'Account is turned off/disabled in Shield'}">⊘ Disabled in Shield</span>`
                    : isForbidden
                    ? `<span class="compact-reset-pill pill-forbidden" title="${acc.forbiddenReason || 'Forbidden (403)'}">✕ Forbidden</span>`
                    : (fiveHourRem >= 100 && weeklyRem > 0)
                    ? `<span class="compact-reset-pill" style="color: #10b981; border-color: rgba(16, 185, 129, 0.3);">✓ Ready</span>`
                    : `<span class="compact-reset-pill" data-reset-ms="${targetResetMs}" title="Resets in ${resetTimerDisplay}">⏳ ${resetTimerDisplay}</span>`
                }
                ${usedFormatted ? `<span class="compact-usage-val" title="${usedTokens.toLocaleString()} tokens consumed">${usedFormatted} used</span>` : ''}
              </div>
            </div>
          </div>

          <div class="row-right">
            ${
              isActive
                ? `<span class="pill-active-check">Active ✓</span>`
                : isBlocked
                  ? `<button class="btn-compact-verify" data-action="verify-shield" data-email="${acc.email}" onclick="verifyInShield('${acc.email}')" title="${acc.validationBlockedReason || 'Verification Required in Shield. Click for instructions.'}">
                      ⚠️ Verify
                     </button>`
                  : isDisabled
                    ? `<button class="btn-compact-disabled" disabled title="Account is turned off / disabled in Antigravity Shield">
                        Off
                       </button>`
                    : isForbidden
                      ? `<button class="btn-compact-disabled" disabled title="${acc.forbiddenReason || 'Forbidden (403)'}">
                          403
                         </button>`
                      : isDepleted
                        ? `<span class="pill-depleted-wait" data-reset-ms="${targetResetMs}" title="Quota resets in ${resetTimerDisplay}">⏳ ${resetTimerDisplay}</span>`
                        : `<button class="btn-compact-switch" data-action="switch-account" data-email="${acc.email}" onclick="switchAccount(this, '${acc.email}')">
                            ⚡ Switch
                           </button>`
            }
          </div>
        </div>
      `;
      })
      .join('');

    const tgConfig = this.telegramService
      ? this.telegramService.getConfig()
      : {
          enabled: false,
          botToken: '',
          chatId: '',
          notifyOnCompletion: true,
          notifyOnNeedInput: true,
          notifyOnError: true,
          status: 'disconnected' as const,
        };

    const policyConfig = this.autoApproveService
      ? this.autoApproveService.getConfig()
      : {
          enabled: true,
          autoApproveReads: true,
          autoApproveWorkspaceWrites: true,
          autoApproveSafeCommands: true,
          commandWhitelist: ['npm test', 'npm run build', 'cargo check', 'cargo test', 'git status', 'git diff', 'pytest'],
          zeroTokenWasteCircuitBreaker: true,
          maxConsecutiveFailures: 3,
          maxTokensPerTask: 150000,
        };

    const tgStatusClass =
      tgConfig.status === 'connected'
        ? 'status-badge-connected'
        : tgConfig.status === 'pairing'
          ? 'status-badge-pairing'
          : 'status-badge-disconnected';

    const tgStatusText =
      tgConfig.status === 'connected'
        ? '🟢 Linked'
        : tgConfig.status === 'pairing'
          ? '🟡 Pairing...'
          : '⚪ Unlinked';

    const isTunnelRunning = (this.mobileTunnelService && this.mobileTunnelService.isTunnelRunning()) || Boolean(tgConfig.cloudflareTunnelUrl);
    const magicLink = this.telegramService
      ? this.telegramService.getMagicLink(tgConfig.cloudflareTunnelUrl)
      : (tgConfig.cloudflareTunnelUrl || 'http://127.0.0.1:8045') + '/mobile-view';
    const qrSvg = (isTunnelRunning || tgConfig.cloudflareTunnelUrl) ? generateQrSvg(magicLink, 160) : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: vscode-resource: vscode-webview:; style-src 'unsafe-inline' https: vscode-resource: vscode-webview:; script-src 'unsafe-inline' https: vscode-resource: vscode-webview:; font-src https: data: vscode-resource: vscode-webview:; connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:*;">
  <title>Antigravity Toolkit 2.0</title>
  <style>
    @font-face {
      font-family: 'Vazirmatn';
      src: local('Vazirmatn'), local('Vazirmatn UI'), local('Vazir'), local('Vazir UI');
      font-weight: 100 900;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'Vazir';
      src: local('Vazir'), local('Vazirmatn');
      font-weight: 100 900;
      font-style: normal;
      font-display: swap;
    }

    :root {
      --font-family: 'Vazirmatn', 'Vazir', var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
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
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    input, button, select, textarea {
      font-family: inherit;
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
      white-space: nowrap;
    }

    .pill-claude-model {
      font-size: 8.5px;
      font-weight: 800;
      color: #431407;
      background: #fb923c;
      padding: 1px 6px;
      border-radius: 999px;
      letter-spacing: 0.04em;
      box-shadow: 0 0 8px rgba(251, 146, 60, 0.4);
      white-space: nowrap;
    }

    .pill-gemini-standby {
      font-size: 8.5px;
      font-weight: 800;
      color: #042f2e;
      background: #38bdf8;
      padding: 1px 6px;
      border-radius: 999px;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    .pill-standby-model {
      font-size: 8.5px;
      font-weight: 600;
      color: #94a3b8;
      background: rgba(255, 255, 255, 0.06);
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      white-space: nowrap;
    }

    .active-session-model-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px 12px;
      margin-top: 4px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    .model-badge-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .active-model-name {
      font-size: 10.5px;
      font-weight: 600;
      color: #e2e8f0;
      white-space: nowrap;
    }

    .active-model-claude {
      color: #fed7aa;
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

    /* Shield Blocked & Disabled Row States */
    .compact-account-row.row-blocked {
      border: 1px solid rgba(245, 158, 11, 0.4);
      background: rgba(245, 158, 11, 0.04);
      border-left: 3px solid #f59e0b;
    }

    .compact-account-row.row-disabled {
      opacity: 0.55;
      filter: grayscale(0.5);
      border-color: rgba(255, 255, 255, 0.05);
      background: rgba(15, 23, 42, 0.35);
    }

    .compact-account-row.row-disabled:hover {
      opacity: 0.8;
    }

    .badge-blocked-orange {
      background: rgba(245, 158, 11, 0.18);
      color: #f59e0b;
      border: 1px solid rgba(245, 158, 11, 0.4);
    }

    .badge-shield-disabled {
      background: rgba(100, 116, 139, 0.18);
      color: #94a3b8;
      border: 1px solid rgba(100, 116, 139, 0.3);
    }

    .compact-reset-pill.pill-blocked {
      color: #fbbf24;
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.3);
    }

    .compact-reset-pill.pill-disabled {
      color: #94a3b8;
      background: rgba(100, 116, 139, 0.1);
      border-color: rgba(100, 116, 139, 0.25);
    }

    .compact-reset-pill.pill-forbidden {
      color: #f43f5e;
      background: rgba(244, 63, 94, 0.1);
      border-color: rgba(244, 63, 94, 0.3);
    }

    .btn-compact-verify {
      background: rgba(245, 158, 11, 0.14);
      border: 1px solid rgba(245, 158, 11, 0.45);
      color: #fbbf24;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn-compact-verify:hover {
      background: rgba(245, 158, 11, 0.26);
      border-color: #f59e0b;
      box-shadow: 0 0 8px rgba(245, 158, 11, 0.4);
    }

    .btn-compact-disabled {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #64748b;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 10px;
      font-weight: 600;
      cursor: not-allowed;
      opacity: 0.6;
    }

    .active-alert-box {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      margin-bottom: 8px;
      font-size: 11px;
      line-height: 1.4;
    }

    .active-alert-box.alert-warning {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.35);
      color: #fef3c7;
    }

    .active-alert-box.alert-danger {
      background: rgba(244, 63, 94, 0.12);
      border: 1px solid rgba(244, 63, 94, 0.35);
      color: #ffe4e6;
    }

    .active-alert-box .alert-icon {
      font-size: 14px;
      flex-shrink: 0;
    }

    .active-alert-box .alert-title {
      font-weight: 700;
      margin-bottom: 2px;
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
      direction: auto;
      unicode-bidi: plaintext;
      text-align: start;
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

    /* Chat Scope Filter Bar */
    .chat-scope-bar {
      display: flex;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 3px;
      gap: 4px;
      margin-bottom: 6px;
    }

    .chat-scope-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      font-size: 10px;
      font-weight: 600;
      padding: 5px 8px;
      border-radius: 7px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .chat-scope-btn:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.05);
    }

    .chat-scope-btn.active {
      background: var(--seafoam-bg);
      border-color: var(--seafoam);
      color: var(--seafoam-light);
      box-shadow: 0 0 10px var(--seafoam-glow);
    }

    /* Chat Search Toolbar */
    .chat-search-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 6px 8px;
      margin-bottom: 8px;
    }

    .chat-search-row {
      display: flex;
      align-items: center;
      width: 100%;
    }

    .chat-search-input-wrap {
      display: flex;
      align-items: center;
      width: 100%;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 7px;
      padding: 3px 7px;
      gap: 6px;
      transition: all 0.2s ease;
    }

    .chat-search-input-wrap:focus-within {
      border-color: var(--seafoam);
      box-shadow: 0 0 8px var(--seafoam-glow);
      background: rgba(0, 0, 0, 0.55);
    }

    .chat-search-icon {
      font-size: 11px;
      opacity: 0.85;
      user-select: none;
      flex-shrink: 0;
    }

    .chat-search-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #f1f5f9;
      font-size: 11px;
      font-family: inherit;
      padding: 2px 0;
      min-width: 0;
    }

    .chat-search-input::placeholder {
      color: #64748b;
      font-size: 10.5px;
    }

    .chat-search-clear {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 11px;
      cursor: pointer;
      padding: 1px 4px;
      border-radius: 4px;
      line-height: 1;
      flex-shrink: 0;
      transition: color 0.15s;
    }

    .chat-search-clear:hover {
      color: #fff;
    }

    .chat-search-btn {
      background: linear-gradient(135deg, #0f766e 0%, #14b8a6 100%);
      color: #fff;
      border: none;
      border-radius: 5px;
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
      box-shadow: 0 1px 6px var(--seafoam-glow);
      transition: opacity 0.15s;
    }

    .chat-search-btn:hover {
      opacity: 0.9;
    }

    .chat-search-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Content Search Results View */
    .search-results-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 8px;
      background: rgba(20, 184, 166, 0.12);
      border: 1px solid rgba(45, 212, 191, 0.25);
      border-radius: 8px;
      font-size: 10.5px;
    }

    .search-results-info {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .search-badge-query {
      color: var(--seafoam-light);
      font-weight: 600;
    }

    .search-badge-count {
      color: #cbd5e1;
      font-size: 9.5px;
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 5px;
      border-radius: 4px;
    }

    .search-results-dismiss {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 10px;
      cursor: pointer;
      padding: 2px 5px;
      border-radius: 4px;
      transition: color 0.15s;
    }

    .search-results-dismiss:hover {
      color: #f87171;
    }

    /* Search snippet boxes */
    .search-snippets-wrap {
      display: flex;
      flex-direction: column;
      gap: 5px;
      margin: 6px 0;
      background: rgba(0, 0, 0, 0.35);
      border-radius: 6px;
      padding: 6px 8px;
      border-left: 2px solid var(--seafoam);
    }

    .search-snippet-item {
      font-size: 10.5px;
      color: #cbd5e1;
      line-height: 1.5;
      word-break: break-word;
      display: flex;
      align-items: baseline;
      gap: 6px;
    }

    .search-snippet-item.is-rtl {
      direction: rtl;
      text-align: right;
      unicode-bidi: plaintext;
    }

    .search-snippet-item.is-ltr {
      direction: ltr;
      text-align: left;
    }

    .search-snippet-text {
      flex: 1;
    }

    .search-snippet-role {
      font-weight: 700;
      font-size: 8.5px;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 3px;
      flex-shrink: 0;
      letter-spacing: 0.02em;
    }

    .search-snippet-item.is-rtl .search-snippet-role {
      margin-right: 0;
      margin-left: 2px;
    }

    .search-snippet-role.role-user {
      background: rgba(56, 189, 248, 0.2);
      color: #38bdf8;
    }

    .search-snippet-role.role-assistant {
      background: rgba(45, 212, 191, 0.2);
      color: #2dd4bf;
    }

    .search-snippet-role.role-system {
      background: rgba(148, 163, 184, 0.2);
      color: #94a3b8;
    }

    mark.search-highlight {
      background: rgba(20, 184, 166, 0.45);
      color: #5eead4;
      font-weight: 700;
      padding: 0 2px;
      border-radius: 2px;
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
      text-align: left;
    }

    .remote-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .remote-title-box {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .remote-icon-wrapper {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--seafoam-bg);
      border: 1px solid var(--seafoam);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
      box-shadow: 0 0 10px var(--seafoam-glow);
    }

    .remote-title {
      font-size: 12px;
      font-weight: 700;
      color: #fff;
    }

    .remote-status-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 12px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .status-badge-connected {
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: #4ade80;
    }

    .status-badge-pairing {
      background: rgba(234, 179, 8, 0.15);
      border: 1px solid rgba(234, 179, 8, 0.4);
      color: #facc15;
    }

    .status-badge-disconnected {
      background: rgba(148, 163, 184, 0.12);
      border: 1px solid rgba(148, 163, 184, 0.25);
      color: #94a3b8;
    }

    .remote-desc {
      font-size: 10px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .remote-form-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 4px;
    }

    .remote-form-label {
      font-size: 9.5px;
      font-weight: 600;
      color: #cbd5e1;
      display: flex;
      justify-content: space-between;
    }

    .remote-form-input {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      padding: 6px 8px;
      color: #f8fafc;
      font-size: 10.5px;
      outline: none;
      transition: border-color 0.15s;
      width: 100%;
      box-sizing: border-box;
      font-family: monospace;
    }

    .remote-form-input:focus {
      border-color: var(--seafoam);
      box-shadow: 0 0 6px var(--seafoam-glow);
    }

    .remote-check-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 6px;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 8px;
      padding: 8px;
    }

    .remote-check-item {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 10px;
      color: #e2e8f0;
      cursor: pointer;
      user-select: none;
    }

    .remote-check-item input[type="checkbox"] {
      accent-color: var(--seafoam);
      width: 13px;
      height: 13px;
      cursor: pointer;
      margin: 0;
    }

    .remote-btn-row {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }

    .remote-btn {
      flex: 1;
      padding: 7px 10px;
      border-radius: 7px;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      transition: all 0.15s ease;
      border: none;
    }

    .remote-btn-primary {
      background: linear-gradient(135deg, #0f766e 0%, #14b8a6 100%);
      color: #fff;
      box-shadow: 0 2px 8px var(--seafoam-glow);
    }

    .remote-btn-primary:hover {
      opacity: 0.92;
      transform: translateY(-1px);
    }

    .remote-btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
    }

    .remote-btn-secondary:hover {
      background: rgba(255, 255, 255, 0.09);
      color: #fff;
    }

    .remote-pairing-box {
      background: rgba(20, 184, 166, 0.08);
      border: 1px dashed rgba(45, 212, 191, 0.3);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 10px;
      color: #5eead4;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 4px;
    }

    .remote-action-btn:disabled,
    .btn-dock:disabled {
      background: rgba(255, 255, 255, 0.04) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      color: var(--text-muted, #94a3b8) !important;
      opacity: 0.55;
      cursor: not-allowed !important;
      box-shadow: none !important;
      pointer-events: none;
      transform: none !important;
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

    /* ==========================================================================
       Cyber-Glass Conversation & Brain Preview Modal
       ========================================================================== */
    .conv-modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 99999;
      background: rgba(5, 10, 20, 0.85);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px;
      animation: modalFadeIn 0.2s ease-out;
    }

    @keyframes modalFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .conv-modal-dialog {
      position: relative;
      width: 100%;
      max-width: 620px;
      height: 88vh;
      max-height: 820px;
      background: #0b1220;
      border: 1px solid rgba(45, 212, 191, 0.3);
      border-radius: 12px;
      box-shadow: 0 25px 65px rgba(0, 0, 0, 0.85), 0 0 35px rgba(45, 212, 191, 0.15);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: dialogPop 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes dialogPop {
      from { opacity: 0; transform: scale(0.96) translateY(6px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }

    .conv-modal-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      padding: 10px 14px;
      background: rgba(15, 23, 42, 0.95);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      gap: 10px;
      flex-shrink: 0;
    }

    .conv-modal-title-group {
      flex: 1 1 auto;
      min-width: 0;
    }

    .conv-modal-title {
      font-size: 13px;
      font-weight: 700;
      color: #f8fafc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      unicode-bidi: plaintext;
    }

    .conv-modal-sub {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
      align-items: center;
    }

    .conv-badge {
      font-size: 9px;
      font-weight: 600;
      padding: 1.5px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      color: #cbd5e1;
      border: 1px solid rgba(255, 255, 255, 0.08);
      white-space: nowrap;
    }

    .conv-badge.badge-date {
      color: var(--seafoam-light);
      background: rgba(45, 212, 191, 0.12);
      border-color: rgba(45, 212, 191, 0.25);
    }

    .conv-badge.badge-project {
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.12);
      border-color: rgba(56, 189, 248, 0.25);
    }

    .conv-modal-actions {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
    }

    .conv-action-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #cbd5e1;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
    }

    .conv-action-btn:hover {
      background: rgba(45, 212, 191, 0.15);
      border-color: var(--seafoam);
      color: #ffffff;
      transform: translateY(-1px);
    }

    .conv-action-btn.conv-action-primary {
      background: linear-gradient(135deg, rgba(15, 118, 110, 0.85), rgba(20, 184, 166, 0.95));
      border-color: var(--seafoam-light);
      color: #ffffff;
      box-shadow: 0 2px 8px rgba(45, 212, 191, 0.25);
    }

    .conv-action-btn.conv-action-primary:hover {
      background: linear-gradient(135deg, rgba(20, 184, 166, 0.95), rgba(45, 212, 191, 1));
      box-shadow: 0 2px 12px rgba(45, 212, 191, 0.4);
    }

    .conv-modal-close {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.05);
      color: #94a3b8;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .conv-modal-close:hover {
      background: rgba(239, 68, 68, 0.25);
      border-color: #ef4444;
      color: #ffffff;
    }

    .conv-modal-tabs {
      display: flex;
      gap: 4px;
      padding: 6px 12px;
      background: rgba(10, 16, 28, 0.95);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      overflow-x: auto;
      flex-shrink: 0;
    }

    .conv-tab-btn {
      font-size: 10.5px;
      padding: 3px 9px;
      border-radius: 6px;
      background: transparent;
      border: 1px solid transparent;
      color: #94a3b8;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .conv-tab-btn:hover {
      color: #cbd5e1;
      background: rgba(255, 255, 255, 0.04);
    }

    .conv-tab-btn.active {
      background: rgba(45, 212, 191, 0.14);
      border-color: var(--seafoam);
      color: var(--seafoam-light);
      font-weight: 600;
    }

    .conv-modal-body {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      color: #e2e8f0;
      font-size: 11.5px;
      line-height: 1.6;
    }

    .conv-loading-shimmer {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 16px;
      gap: 12px;
      color: #94a3b8;
      font-size: 11px;
    }

    .conv-shimmer-spinner {
      width: 22px;
      height: 22px;
      border: 2px solid rgba(45, 212, 191, 0.2);
      border-top-color: var(--seafoam);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    .conv-turn {
      border-radius: 8px;
      padding: 10px 12px;
      position: relative;
    }

    .conv-turn.is-rtl {
      direction: rtl;
      text-align: right;
    }

    .conv-turn-user {
      background: rgba(30, 41, 59, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.09);
    }

    .conv-turn-assistant {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(45, 212, 191, 0.18);
    }

    .conv-turn-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
      font-size: 10px;
    }

    .conv-role-badge {
      font-weight: 700;
      font-size: 9.5px;
      padding: 1px 6px;
      border-radius: 4px;
    }

    .conv-role-user {
      background: rgba(56, 189, 248, 0.16);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }

    .conv-role-assistant {
      background: rgba(45, 212, 191, 0.16);
      color: var(--seafoam-light);
      border: 1px solid rgba(45, 212, 191, 0.3);
    }

    .conv-turn-time {
      font-size: 8.5px;
      color: #64748b;
    }

    .conv-thought-box {
      background: rgba(2, 6, 23, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.22);
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }

    .conv-thought-header {
      padding: 5px 8px;
      font-size: 10px;
      font-weight: 600;
      color: #94a3b8;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      background: rgba(255, 255, 255, 0.02);
      transition: background 0.15s ease;
    }

    .conv-thought-header:hover {
      color: #e2e8f0;
      background: rgba(255, 255, 255, 0.05);
    }

    .conv-thought-chevron {
      font-size: 12px;
      display: inline-block;
      transition: transform 0.2s ease;
    }

    .conv-thought-body {
      padding: 8px 10px;
      font-size: 10.5px;
      color: #94a3b8;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      max-height: 220px;
      overflow-y: auto;
      line-height: 1.5;
    }

    .conv-tools-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 8px;
    }

    .conv-tool-pill {
      font-size: 9px;
      font-family: monospace;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(168, 85, 247, 0.12);
      border: 1px solid rgba(168, 85, 247, 0.25);
      color: #c084fc;
    }

    .conv-code-box {
      background: #020617;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      margin: 8px 0;
      overflow: hidden;
      direction: ltr !important;
      text-align: left !important;
    }

    .conv-code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 8px;
      background: rgba(255, 255, 255, 0.04);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 9px;
      color: #94a3b8;
    }

    .conv-code-lang {
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .conv-copy-btn {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 8.5px;
      color: #cbd5e1;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .conv-copy-btn:hover {
      border-color: #38bdf8;
      color: #38bdf8;
    }

    .conv-code-box pre {
      margin: 0;
      padding: 8px 10px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 10.5px;
      line-height: 1.45;
      color: #e2e8f0;
    }

    .conv-inline-code {
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: ui-monospace, monospace;
      font-size: 10px;
      color: #38bdf8;
      direction: ltr !important;
      display: inline-block;
    }

    .conv-md-h2 {
      font-size: 13px;
      font-weight: 700;
      color: #f1f5f9;
      margin: 10px 0 5px 0;
    }

    .conv-md-h3 {
      font-size: 12px;
      font-weight: 700;
      color: #e2e8f0;
      margin: 8px 0 4px 0;
    }

    .conv-md-h4 {
      font-size: 11.5px;
      font-weight: 600;
      color: #cbd5e1;
      margin: 6px 0 3px 0;
    }

    .conv-md-quote {
      border-left: 3px solid var(--seafoam);
      margin: 6px 0;
      padding: 4px 8px;
      background: rgba(45, 212, 191, 0.05);
      color: #94a3b8;
      font-size: 11px;
    }

    .conv-turn.is-rtl .conv-md-quote {
      border-left: none;
      border-right: 3px solid var(--seafoam);
    }

    .conv-md-li {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin: 3px 0;
    }

    .conv-bullet {
      color: var(--seafoam);
      font-weight: bold;
    }

    .conv-num-bullet {
      color: var(--seafoam-light);
      font-weight: 600;
      font-size: 10px;
    }

    .conv-md-hr {
      border: 0;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      margin: 10px 0;
    }

    .conv-md-gap {
      height: 8px;
    }

    .conv-artifact-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      margin-bottom: 10px;
      font-size: 10.5px;
      color: #cbd5e1;
    }

    .conv-mini-btn {
      font-size: 9.5px;
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(45, 212, 191, 0.12);
      border: 1px solid rgba(45, 212, 191, 0.3);
      color: var(--seafoam-light);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .conv-mini-btn:hover {
      background: rgba(45, 212, 191, 0.25);
      color: #fff;
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
        <span class="brand-version-pill">v${extensionVersion}</span>
      </div>
      <div class="shield-status-indicator" title="${isShieldOnline ? 'Connected to local Shield daemon (Port 8045)' : 'Shield daemon unreachable on port 8045'}">
        <span class="shield-dot"></span>
        <span>${isShieldOnline ? 'Shield Linked' : 'Shield Offline'}</span>
      </div>
    </div>

    <!-- Smart Responsive Tabs Navigation -->
    <div class="tab-navigation">
      <button class="tab-btn ${activeTab === 'overview' ? 'active' : ''}" data-tab="overview" onclick="switchTab('overview')">
        <span class="tab-icon">⚡</span>
        <span>Overview</span>
      </button>
      <button class="tab-btn ${activeTab === 'history' ? 'active' : ''}" data-tab="history" onclick="switchTab('history')">
        <span class="tab-icon">📜</span>
        <span>Chats</span>
      </button>
      <button class="tab-btn ${activeTab === 'remote' ? 'active' : ''}" data-tab="remote" onclick="switchTab('remote')">
        <span class="tab-icon">📱</span>
        <span>Remote</span>
      </button>
      <button class="tab-btn ${activeTab === 'bridge' ? 'active' : ''}" data-tab="bridge" onclick="switchTab('bridge')">
        <span class="tab-icon">🛡️</span>
        <span>Bridge</span>
      </button>
    </div>

    <!-- TAB 1: OVERVIEW -->
    <div id="tab-overview" class="tab-content ${activeTab === 'overview' ? 'active' : ''}">
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
          <div class="model-badge-group">
            <span class="pill-active-model">⚡ ACTIVE IN IDE</span>
            <span class="active-model-name">${primaryModel}</span>
          </div>
          ${secondaryModel ? `
          <div class="model-badge-group claude-badge-group">
            <span class="${isClaudeActive ? 'pill-gemini-standby' : 'pill-claude-model'}">${isClaudeActive ? '⚡ GEMINI' : '⚡ CLAUDE'}</span>
            <span class="active-model-name ${isClaudeActive ? '' : 'active-model-claude'}">${secondaryModel}</span>
          </div>` : ''}
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

      ${activeAccountAlertHtml}

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
    <div id="tab-history" class="tab-content ${activeTab === 'history' ? 'active' : ''}">
      <div class="chat-scope-bar">
        <button class="chat-scope-btn active" id="btn-scope-workspace" onclick="switchChatScope('workspace')">
          <span>📂 ${currentWorkspaceName || 'Current'} (${workspaceConversations.length})</span>
        </button>
        <button class="chat-scope-btn" id="btn-scope-all" onclick="switchChatScope('all')">
          <span>🌐 All Projects (${allConversations.length})</span>
        </button>
        <button class="chat-scope-btn" id="btn-recover-chats" onclick="triggerAutoRecoverChats()" title="بازیابی خودکار مکالمات قطع‌شده و ایندکس‌نشده پس از آپدیت یا کرش" style="flex: 0 0 auto; padding: 0 8px;">
          <span>⚡ ریکاوری خودکار</span>
        </button>
      </div>

      <!-- SEARCH TOOLBAR: Title Search & Message Content Search -->
      <div class="chat-search-container">
        <!-- 1. Search Titles -->
        <div class="chat-search-row">
          <div class="chat-search-input-wrap">
            <span class="chat-search-icon">🏷️</span>
            <input
              type="text"
              id="search-titles-input"
              class="chat-search-input"
              dir="auto"
              value="${escapeHtmlAttr(savedTitleQuery)}"
              placeholder="Search titles / جستجو در تیترها..."
              oninput="handleTitleSearch(this.value)"
              autocomplete="off"
              spellcheck="false"
            />
            <button
              type="button"
              class="chat-search-clear"
              id="btn-clear-title"
              onclick="clearTitleSearch()"
              title="Clear title filter"
              style="${savedTitleQuery ? 'display: inline-block;' : 'display: none;'}"
            >✕</button>
          </div>
        </div>

        <!-- 2. Search Inside Messages / Content -->
        <div class="chat-search-row">
          <div class="chat-search-input-wrap">
            <span class="chat-search-icon">💬</span>
            <input
              type="text"
              id="search-content-input"
              class="chat-search-input"
              dir="auto"
              value="${escapeHtmlAttr(savedContentQuery)}"
              placeholder="Search conversation text / جستجو در متن مکالمات..."
              oninput="handleContentSearchInput(this.value)"
              onkeydown="if(event.key === 'Enter') executeContentSearch()"
              autocomplete="off"
              spellcheck="false"
            />
            <button
              type="button"
              class="chat-search-btn"
              id="btn-search-content"
              onclick="executeContentSearch()"
              title="Search conversation messages"
            >
              <span id="btn-search-content-label">🔍 Find</span>
            </button>
            <button
              type="button"
              class="chat-search-clear"
              id="btn-clear-content"
              onclick="clearContentSearch()"
              title="Clear text search"
              style="${savedContentQuery ? 'display: inline-block;' : 'display: none;'}"
            >✕</button>
          </div>
        </div>
      </div>

      <!-- Content Search Results Container -->
      <div id="content-search-results-area" style="display: none; flex-direction: column; gap: 8px; margin-bottom: 12px;">
        <div class="search-results-header">
          <div class="search-results-info">
            <span class="search-badge-query">💬 <span id="content-search-query-badge"></span></span>
            <span class="search-badge-count" id="content-search-count-badge">0 Matches</span>
          </div>
          <button type="button" class="search-results-dismiss" onclick="clearContentSearch()">Dismiss ✕</button>
        </div>
        <div id="content-search-results-list" class="timeline-tree"></div>
      </div>

      <div id="scope-workspace-view" style="display: flex; flex-direction: column; gap: 8px;">
        <div class="subhead-title">
          <span>${currentWorkspaceName || 'Workspace'} Sessions</span>
          <span style="font-size: 9px; color: var(--seafoam-light);">${workspaceConversations.length} Chats</span>
        </div>
        ${workspaceTimelineHtml}
      </div>

      <div id="scope-all-view" style="display: none; flex-direction: column; gap: 8px;">
        <div class="subhead-title">
          <span>All Discovered Projects</span>
          <span style="font-size: 9px; color: var(--seafoam-light);">${allConversations.length} Total</span>
        </div>
        ${projectsHtml || '<div style="opacity:0.6; text-align:center; padding:16px;">No conversation transcripts found</div>'}
      </div>
    </div>

    <!-- TAB 3: REMOTE CONTROL -->
    <div id="tab-remote" class="tab-content ${activeTab === 'remote' ? 'active' : ''}">
      <!-- Card 1: Telegram & Mobile -->
      <div class="remote-card">
        <div class="remote-header-row">
          <div class="remote-title-box">
            <div class="remote-icon-wrapper">📱</div>
            <div>
              <div class="remote-title">Antigravity Mobile & Telegram</div>
              <div class="remote-desc">Remote telemetry alerts & smartphone IDE task control</div>
            </div>
          </div>
          <span class="remote-status-badge ${tgStatusClass}">
            ${tgStatusText}
          </span>
        </div>

        <!-- Quick Setup & Permissions Guide -->
        <div style="background: rgba(45, 212, 191, 0.05); border: 1px solid rgba(45, 212, 191, 0.2); border-radius: 8px; padding: 10px; margin-bottom: 12px; font-size: 11px; line-height: 1.5; color: #cbd5e1; direction: rtl; text-align: right;">
          <div style="font-weight: 700; color: #5eead4; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span>📘 راهنمای راه‌اندازی ربات و دسترسی‌های لازم:</span>
          </div>
          <ol style="margin-right: 18px; margin-left: 0; display: flex; flex-direction: column; gap: 5px; font-size: 10.5px;">
            <li><b>ساخت ربات در BotFather:</b> در تلگرام به <code>@BotFather</code> دستور <code>/newbot</code> را بفرستید و توکن را در فیلد اول قرار دهید.</li>
            <li><b>دسترسی خواندن پیام‌ها:</b> در <code>@BotFather</code> دستور <code>/setprivacy</code> را بزنید، ربات خود را انتخاب و روی <b>Disable</b> قرار دهید (تا بتواند پیام‌ها و وویس‌های داخل تاپیک را بشنود).</li>
            <li><b>فعال‌سازی تاپیک در گروه:</b> در یک گروه تلگرام، از منوی تنظیمات گزینه <b>Topics</b> را روشن کنید (ربات نمی‌تواند خودش گروه را تاپیکی کند؛ حتماً مالک گروه با اکانت شخصی باید آن را روشن کند).</li>
            <li><b>ادمین کردن ربات:</b> ربات را به گروه اضافه کرده و با دسترسی <b>Manage Topics</b> (مدیریت موضوع‌ها) و <b>Send Messages</b> ادمین کنید.</li>
            <li><b>شناسه گروه:</b> شناسه سوپرگروه (با فرمت <code>-100...</code>) را در فیلد سوم وارد کنید یا در گروه دستور <code>/pair</code> را امتحان کنید.</li>
          </ol>
        </div>

        <div class="remote-form-group">
          <label class="remote-form-label">
            <span>Telegram Bot Token</span>
            <span style="font-size: 8.5px; opacity: 0.7;">from @BotFather</span>
          </label>
          <input
            type="password"
            id="tg-bot-token"
            class="remote-form-input"
            value="${escapeHtmlAttr(tgConfig.botToken)}"
            placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
            oninput="autoSaveTelegramInput()"
          />
        </div>

        <div class="remote-form-group">
          <label class="remote-form-label">
            <span>Your Telegram Chat ID</span>
            <span style="font-size: 8.5px; opacity: 0.7;">from @userinfobot</span>
          </label>
          <input
            type="text"
            id="tg-chat-id"
            class="remote-form-input"
            value="${escapeHtmlAttr(tgConfig.chatId)}"
            placeholder="e.g. 12345678"
            oninput="autoSaveTelegramInput()"
          />
        </div>

        <div class="remote-form-group">
          <label class="remote-form-label">
            <span>Forum Supergroup ID (with Topics)</span>
            <span style="font-size: 8.5px; opacity: 0.7;">e.g. -100123456789</span>
          </label>
          <input
            type="text"
            id="tg-forum-id"
            class="remote-form-input"
            value="${escapeHtmlAttr(tgConfig.forumSupergroupId || '')}"
            placeholder="-100xxxxxxxxxx (Enables [Project] Topics)"
            oninput="autoSaveTelegramInput()"
          />
        </div>

        ${
          tgConfig.pairingCode
            ? `
        <div class="remote-pairing-box">
          <span>Pairing Code: <b>${tgConfig.pairingCode}</b></span>
          <span style="font-size: 8.5px;">Send <code>/pair ${tgConfig.pairingCode}</code> in Telegram</span>
        </div>
        `
            : ''
        }

        <div class="remote-check-group">
          <label class="remote-check-item">
            <input type="checkbox" id="tg-notify-complete" ${tgConfig.notifyOnCompletion ? 'checked' : ''} onchange="autoSaveTelegramInput()" />
            <span>Notify on Prompt Completion</span>
          </label>
          <label class="remote-check-item">
            <input type="checkbox" id="tg-notify-input" ${tgConfig.notifyOnNeedInput ? 'checked' : ''} onchange="autoSaveTelegramInput()" />
            <span>Notify when Agent Needs Approval</span>
          </label>
          <label class="remote-check-item">
            <input type="checkbox" id="tg-notify-error" ${tgConfig.notifyOnError ? 'checked' : ''} onchange="autoSaveTelegramInput()" />
            <span>Notify on Errors & Circuit Breaker Trips</span>
          </label>
        </div>

        <div class="remote-btn-row">
          <button type="button" class="remote-btn remote-btn-primary" onclick="saveTelegramSettings(false)">
            <span>💾 Save Settings</span>
          </button>
          <button type="button" class="remote-btn remote-btn-primary" style="background: linear-gradient(135deg, #10b981, #059669); color: #fff;" onclick="sendTestTelegramAlert()" title="Send test ping to phone">
            <span>🚀 Test Alert (ارسال پیام تست)</span>
          </button>
          <button type="button" class="remote-btn remote-btn-secondary" onclick="generateTelegramPairCode()" title="Generate 6-digit code for bot">
            <span>🔑 Pair Code</span>
          </button>
        </div>
      </div>

      <!-- Card 2: Agent Auto-Approve Policies -->
      <div class="remote-card" style="margin-top: 10px;">
        <div class="remote-header-row">
          <div class="remote-title-box">
            <div class="remote-icon-wrapper">🤖</div>
            <div>
              <div class="remote-title">Agent Auto-Approve Policies</div>
              <div class="remote-desc">Zero-Token Waste execution & headless auto-accept policies</div>
            </div>
          </div>
          <span class="remote-status-badge ${policyConfig.enabled ? 'status-badge-connected' : 'status-badge-disconnected'}">
            ${policyConfig.enabled ? 'Active ✓' : 'Disabled'}
          </span>
        </div>

        <div class="remote-check-group">
          <label class="remote-check-item" style="font-weight: 700; color: #5eead4;">
            <input type="checkbox" id="policy-enabled" ${policyConfig.enabled ? 'checked' : ''} />
            <span>Enable Autonomous Policy Engine</span>
          </label>
          <label class="remote-check-item">
            <input type="checkbox" id="policy-reads" ${policyConfig.autoApproveReads ? 'checked' : ''} />
            <span>Auto-Approve File Reads (Tier 1 Safe)</span>
          </label>
          <label class="remote-check-item">
            <input type="checkbox" id="policy-writes" ${policyConfig.autoApproveWorkspaceWrites ? 'checked' : ''} />
            <span>Auto-Approve Workspace File Edits (within project root)</span>
          </label>
          <label class="remote-check-item">
            <input type="checkbox" id="policy-commands" ${policyConfig.autoApproveSafeCommands ? 'checked' : ''} />
            <span>Auto-Approve Whitelisted Shell Commands</span>
          </label>
          <label class="remote-check-item">
            <input type="checkbox" id="policy-circuit-breaker" ${policyConfig.zeroTokenWasteCircuitBreaker ? 'checked' : ''} />
            <span>Zero-Token Waste Loop & Stagnation Circuit Breaker</span>
          </label>
        </div>

        <div class="remote-form-group">
          <label class="remote-form-label">
            <span>Whitelisted Shell Commands</span>
            <span style="font-size: 8.5px; opacity: 0.7;">comma separated</span>
          </label>
          <input
            type="text"
            id="policy-whitelist"
            class="remote-form-input"
            value="${escapeHtmlAttr(policyConfig.commandWhitelist.join(', '))}"
            placeholder="npm test, cargo check, git status, git diff, pytest"
          />
        </div>

        <div style="display: flex; gap: 8px;">
          <div class="remote-form-group" style="flex: 1;">
            <label class="remote-form-label">
              <span>Max Failures</span>
            </label>
            <input
              type="number"
              id="policy-max-failures"
              class="remote-form-input"
              value="${policyConfig.maxConsecutiveFailures}"
              min="1"
              max="10"
            />
          </div>
          <div class="remote-form-group" style="flex: 1.5;">
            <label class="remote-form-label">
              <span>Max Tokens / Task</span>
            </label>
            <input
              type="number"
              id="policy-max-tokens"
              class="remote-form-input"
              value="${policyConfig.maxTokensPerTask}"
              step="10000"
              min="10000"
            />
          </div>
        </div>

        <div class="remote-btn-row">
          <button type="button" class="remote-btn remote-btn-primary" onclick="savePolicySettings()">
            <span>💾 Save Policies</span>
          </button>
          <button type="button" class="remote-btn remote-btn-secondary" onclick="resetPolicySettings()">
            <span>🔄 Defaults</span>
          </button>
        </div>
      </div>

      <!-- Card 3: Cloudflare Live Remote View -->
      <div class="remote-card" style="margin-top: 10px;">
        <div class="remote-header-row">
          <div class="remote-title-box">
            <div class="remote-icon-wrapper" style="background: rgba(249, 115, 22, 0.15); border-color: #f97316;">☁️</div>
            <div>
              <div class="remote-title">Cloudflare Live Mobile View</div>
              <div class="remote-desc">Zero-port-forwarding live chat timeline & voice input on smartphone</div>
            </div>
          </div>
          <span id="cf-status-pill" class="remote-status-badge ${isTunnelRunning ? 'status-badge-connected' : 'status-badge-disconnected'}">
            ${isTunnelRunning ? '🟢 Tunnel Live' : '⚪ Offline'}
          </span>
        </div>

        <div class="remote-form-group">
          <label class="remote-form-label">
            <span>Cloudflare Tunnel URL</span>
            <span style="font-size: 8.5px; opacity: 0.7;">https://*.trycloudflare.com</span>
          </label>
          <input
            type="text"
            id="cf-tunnel-url"
            class="remote-form-input"
            value="${escapeHtmlAttr(tgConfig.cloudflareTunnelUrl || '')}"
            placeholder="Click '1-Click Launch' or enter tunnel URL"
          />
        </div>

        <div class="remote-form-group">
          <label class="remote-form-label">
            <span>Cryptographic Session Token</span>
            <span style="font-size: 8.5px; opacity: 0.7;">24-byte hex guard</span>
          </label>
          <input
            type="text"
            id="cf-session-token"
            class="remote-form-input"
            value="${escapeHtmlAttr(tgConfig.sessionAuthToken || '')}"
            readonly
          />
        </div>

        <div id="cf-qrcode-container" style="display: ${isTunnelRunning && magicLink ? 'flex' : 'none'}; flex-direction: column; align-items: center; gap: 8px; margin: 8px 0; padding: 10px; background: rgba(0, 0, 0, 0.3); border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.06);">
          <span style="font-size: 9.5px; color: var(--seafoam-light); font-weight: 600;">📱 Scan with Phone Camera to Open:</span>
          <div id="qrcode-display-box" style="background: #fff; padding: 6px; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.4);">${qrSvg}</div>
          <a id="cf-magic-link-anchor" href="${escapeHtmlAttr(magicLink)}" target="_blank" style="font-size: 9.5px; color: #38bdf8; text-decoration: underline; word-break: break-all; text-align: center;">
            ${escapeHtmlAttr(magicLink)}
          </a>
        </div>

        <div class="remote-btn-row">
          <button type="button" id="btn-cf-launch" class="remote-btn remote-btn-primary" onclick="startCloudflareTunnel()">
            <span>${isTunnelRunning ? '🌐 Open in Browser (باز کردن مرورگر)' : '⚡ 1-Click Launch & Connect (اتصال خودکار)'}</span>
          </button>
          <button type="button" class="remote-btn remote-btn-secondary" onclick="sendTunnelLinkToTelegram()" title="Send Magic Link into Telegram">
            <span>📲 Send to Telegram</span>
          </button>
          <button type="button" id="btn-cf-stop" class="remote-btn" style="display: ${isTunnelRunning ? 'inline-flex' : 'none'}; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171;" onclick="stopCloudflareTunnel()" title="Stop Cloudflare Tunnel">
            <span>🛑 Stop</span>
          </button>
        </div>
      </div>
    </div>

    <!-- TAB 4: SHIELD BRIDGE -->
    <div id="tab-bridge" class="tab-content ${activeTab === 'bridge' ? 'active' : ''}">
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

    <!-- Cyber-Glass Conversation & Brain Preview Modal -->
    <div id="conversation-preview-modal" class="conv-modal-overlay" style="display: none;" onclick="handleModalBackdropClick(event)">
      <div class="conv-modal-dialog" onclick="event.stopPropagation()">
        <!-- Modal Header -->
        <div class="conv-modal-header">
          <div class="conv-modal-title-group">
            <div class="conv-modal-title" id="conv-modal-title">Conversation Preview</div>
            <div class="conv-modal-sub" id="conv-modal-sub"></div>
          </div>
          <div class="conv-modal-actions">
            <button type="button" class="conv-action-btn" id="conv-btn-folder" title="Open Brain Directory in Explorer">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H7.414l-1.707-1.707A1 1 0 0 0 5 2.5H1.5z"/></svg>
              <span>Folder</span>
            </button>
            <button type="button" class="conv-action-btn" id="conv-btn-log" title="Open raw transcript log in Editor">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.5L9.5 0H4zm0 1h5v3.5A1.5 1.5 0 0 0 10.5 6H14v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/></svg>
              <span>Log</span>
            </button>
            <button type="button" class="conv-action-btn conv-action-primary" id="conv-btn-chat" title="Open in Antigravity Chat panel">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2v3.5L8.5 11H14a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9H8.2L6 11.2V10H2V2h12v8z"/></svg>
              <span>Open in Chat</span>
            </button>
            <button type="button" class="conv-modal-close" onclick="closeConversationPreview()" title="Close (Esc)">✕</button>
          </div>
        </div>

        <!-- Optional Artifacts / Tabs navigation -->
        <div class="conv-modal-tabs" id="conv-modal-tabs" style="display: none;"></div>

        <!-- Scrollable Modal Body -->
        <div class="conv-modal-body" id="conv-modal-body"></div>
      </div>
    </div>

  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function switchTab(tabId) {
      if (!tabId) return;
      document.querySelectorAll('.tab-btn').forEach(btn => {
        const d = btn.getAttribute('data-tab');
        const o = btn.getAttribute('onclick') || '';
        if (d === tabId || o.includes(tabId)) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      document.querySelectorAll('.tab-content').forEach(c => {
        if (c.id === 'tab-' + tabId) {
          c.classList.add('active');
        } else {
          c.classList.remove('active');
        }
      });

      try {
        const state = vscode.getState() || {};
        state.activeTab = tabId;
        vscode.setState(state);
      } catch (e) {}

      try {
        vscode.postMessage({ command: 'tabChanged', tab: tabId });
      } catch (e) {}
    }

    // Delegated click listener to guarantee switching even if inline handlers are restricted
    document.addEventListener('click', function(e) {
      // 1. Tab buttons
      const tabBtn = e.target.closest('.tab-btn');
      if (tabBtn) {
        const tabId = tabBtn.getAttribute('data-tab');
        if (tabId) {
          switchTab(tabId);
        }
        return;
      }

      // 1.1 Modal Tabs (Turns vs Artifacts)
      const modalTabBtn = e.target.closest('.conv-tab-btn');
      if (modalTabBtn) {
        const modalTabId = modalTabBtn.getAttribute('data-modaltab');
        if (modalTabId) {
          switchModalTab(modalTabId);
        }
        return;
      }

      // 1.2 Modal open raw transcript log
      const modalRawBtn = e.target.closest('#conv-btn-open-raw');
      if (modalRawBtn && activePreviewData && activePreviewData.sessionId) {
        openModalTranscript(activePreviewData.sessionId);
        return;
      }

      // 2. Compact Switch buttons
      const switchBtn = e.target.closest('.btn-compact-switch');
      if (switchBtn) {
        const email = switchBtn.getAttribute('data-email');
        if (email) {
          switchAccount(switchBtn, email);
        }
        return;
      }

      // 3. Compact Verify buttons
      const verifyBtn = e.target.closest('.btn-compact-verify');
      if (verifyBtn) {
        const email = verifyBtn.getAttribute('data-email');
        if (email) {
          verifyInShield(email);
        }
        return;
      }

      // 4. Auto-Switch toggle button
      const autoBtn = e.target.closest('.btn-toggle-auto');
      if (autoBtn) {
        toggleAutoSwitch();
        return;
      }

      // 5. Quota window toggle buttons
      const quotaBtn = e.target.closest('.quota-toggle-btn');
      if (quotaBtn) {
        if (quotaBtn.id === 'btn-quota-5h') setQuotaWindow('5h');
        else if (quotaBtn.id === 'btn-quota-weekly') setQuotaWindow('weekly');
        return;
      }
    });

    // Restore persisted active tab on client load if previously saved
    try {
      const savedState = vscode.getState();
      if (savedState && savedState.activeTab && savedState.activeTab !== '${activeTab}') {
        switchTab(savedState.activeTab);
      }
    } catch (e) {}

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
      } else if (btnOrEmail && btnOrEmail.nodeType) {
        btn = btnOrEmail;
        email = emailArg || btn.getAttribute('data-email') || '';
      } else {
        email = emailArg || '';
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

      // Safety timeout: auto re-enable buttons after 7 seconds if no response to prevent lockup
      setTimeout(() => {
        document.querySelectorAll('.btn-compact-switch').forEach(b => {
          b.disabled = false;
          b.style.pointerEvents = 'auto';
          if (b.classList.contains('btn-loading')) {
            b.classList.remove('btn-loading');
            b.innerHTML = '⚡ Switch';
          }
        });
      }, 7000);

      vscode.postMessage({ command: 'switchAccount', email: email });
    }

    function verifyInShield(email) {
      vscode.postMessage({ command: 'verifyInShield', email: email });
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

    function handleOpenChat(el, sessionId) {
      if (!sessionId) return;

      // Visually give fast, phased feedback on clicked button during the automation
      const targetBtn = document.getElementById('btn-open-' + sessionId);
      if (targetBtn) {
        targetBtn.classList.add('btn-opening');
        targetBtn.innerHTML = '<span class="node-btn-spinner"></span> Opening Picker...';

        setTimeout(() => {
          if (targetBtn.classList.contains('btn-opening')) {
            targetBtn.innerHTML = '<span class="node-btn-spinner"></span> Pasting Title...';
          }
        }, 400);

        setTimeout(() => {
          if (targetBtn.classList.contains('btn-opening')) {
            targetBtn.innerHTML = '<span class="node-btn-spinner"></span> Selecting (↓)...';
          }
        }, 1000);

        setTimeout(() => {
          if (targetBtn.classList.contains('btn-opening')) {
            targetBtn.innerHTML = '<span class="node-btn-spinner"></span> Entering (↵)...';
          }
        }, 1400);

        setTimeout(() => {
          targetBtn.classList.remove('btn-opening');
          targetBtn.innerHTML = '<svg class="node-btn-svg" viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2v3.5L8.5 11H14a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9H8.2L6 11.2V10H2V2h12v8z"/></svg> <span>Open in Chat</span>';
        }, 2000);
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

    function handleOpenChatNode(el) {
      var node = (el && el.closest) ? (el.closest('.timeline-node') || el) : el;
      var sid = node ? node.getAttribute('data-session-id') : '';
      if (sid) handleOpenChat(el, sid);
    }

    function openTranscriptNode(el) {
      var node = (el && el.closest) ? (el.closest('.timeline-node') || el) : el;
      var sid = node ? node.getAttribute('data-session-id') : '';
      if (sid) openTranscriptOnly(sid);
    }

    var activeTitleFilter = '';
    var currentContentSearchQuery = '';

    function escapeRegex(str) {
      var specials = ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\\\'];
      var s = str || '';
      for (var i = 0; i < specials.length; i++) {
        s = s.split(specials[i]).join('\\\\' + specials[i]);
      }
      return s;
    }

    function escapeHtml(str) {
      return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    var titleSearchDebounceTimer = null;
    var lastAppliedTitleFilter = null;

    function handleTitleSearch(value) {
      var val = (value || '').trim();
      var clearBtn = document.getElementById('btn-clear-title');
      if (clearBtn) clearBtn.style.display = val ? 'inline-block' : 'none';

      if (titleSearchDebounceTimer) {
        clearTimeout(titleSearchDebounceTimer);
        titleSearchDebounceTimer = null;
      }

      if (!val) {
        applyTitleFilter('');
        return;
      }

      // 140ms debounce to prevent synchronous layout thrashing on every keystroke
      titleSearchDebounceTimer = setTimeout(function() {
        applyTitleFilter(val);
      }, 140);
    }

    function applyTitleFilter(value) {
      var cleanVal = (value || '').trim();
      if (cleanVal === lastAppliedTitleFilter) return;
      lastAppliedTitleFilter = cleanVal;
      activeTitleFilter = cleanVal;

      window.requestAnimationFrame(function() {
        var q = cleanVal.toLowerCase();
        var regex = q ? new RegExp('(' + escapeRegex(q) + ')', 'gi') : null;

        // 1. Filter nodes in Workspace View
        var wsNodes = document.querySelectorAll('#scope-workspace-view .timeline-node');
        for (var i = 0; i < wsNodes.length; i++) {
          var node = wsNodes[i];
          var titleEl = node.querySelector('.node-title');
          var origTitle = titleEl ? (titleEl.getAttribute('data-original-title') || titleEl.innerText) : '';
          if (titleEl && !titleEl.getAttribute('data-original-title')) {
            titleEl.setAttribute('data-original-title', origTitle);
          }

          var matches = !q || origTitle.toLowerCase().indexOf(q) !== -1;
          node.style.display = matches ? 'flex' : 'none';
          if (matches && titleEl) {
            if (q) {
              titleEl.innerHTML = escapeHtml(origTitle).replace(regex, '<mark class="search-highlight">$1</mark>');
            } else {
              titleEl.innerText = origTitle;
            }
          }
        }

        // 2. Filter nodes and cards in All Projects View
        var projectCards = document.querySelectorAll('#scope-all-view .project-cluster-card');
        for (var c = 0; c < projectCards.length; c++) {
          var card = projectCards[c];
          var pName = card.getAttribute('data-project-name') || '';
          var nodes = card.querySelectorAll('.timeline-node');
          var cardMatchCount = 0;

          for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            var tEl = n.querySelector('.node-title');
            var oTitle = tEl ? (tEl.getAttribute('data-original-title') || tEl.innerText) : '';
            if (tEl && !tEl.getAttribute('data-original-title')) {
              tEl.setAttribute('data-original-title', oTitle);
            }

            var nMatches = !q || oTitle.toLowerCase().indexOf(q) !== -1 || pName.toLowerCase().indexOf(q) !== -1;
            n.style.display = nMatches ? 'flex' : 'none';
            if (nMatches) {
              cardMatchCount++;
              if (tEl) {
                if (q && oTitle.toLowerCase().indexOf(q) !== -1) {
                  tEl.innerHTML = escapeHtml(oTitle).replace(regex, '<mark class="search-highlight">$1</mark>');
                } else {
                  tEl.innerText = oTitle;
                }
              }
            }
          }

          if (!q) {
            card.style.display = '';
          } else {
            card.style.display = cardMatchCount > 0 ? '' : 'none';
            if (cardMatchCount > 0) {
              var body = card.querySelector('.project-body');
              var chevron = card.querySelector('.project-chevron');
              if (body) body.style.display = '';
              if (chevron) chevron.innerText = '▼';
              card.classList.add('is-expanded');
              card.classList.remove('is-collapsed');
            }
          }
        }
      });
    }

    function handleTitleSearch(val) {
      var rawVal = val || '';
      activeTitleFilter = rawVal.trim();
      var clearBtn = document.getElementById('btn-clear-title');
      if (clearBtn) clearBtn.style.display = activeTitleFilter ? 'inline-block' : 'none';

      try {
        var state = vscode.getState() || {};
        state.titleSearchQuery = rawVal;
        vscode.setState(state);
        vscode.postMessage({
          command: 'searchStateChanged',
          titleQuery: rawVal,
          isFocused: true
        });
      } catch (e) {}

      if (titleSearchDebounceTimer) {
        clearTimeout(titleSearchDebounceTimer);
        titleSearchDebounceTimer = null;
      }

      titleSearchDebounceTimer = setTimeout(function() {
        applyTitleFilter(activeTitleFilter);
      }, 150);
    }

    function clearTitleSearch() {
      if (titleSearchDebounceTimer) {
        clearTimeout(titleSearchDebounceTimer);
        titleSearchDebounceTimer = null;
      }
      var input = document.getElementById('search-titles-input');
      if (input) input.value = '';
      var clearBtn = document.getElementById('btn-clear-title');
      if (clearBtn) clearBtn.style.display = 'none';

      try {
        var state = vscode.getState() || {};
        state.titleSearchQuery = '';
        vscode.setState(state);
        vscode.postMessage({
          command: 'searchStateChanged',
          titleQuery: '',
          isFocused: false
        });
      } catch (e) {}

      applyTitleFilter('');
    }

    var contentSearchDebounceTimer = null;

    function handleContentSearchInput(val) {
      var rawVal = val || '';
      var query = rawVal.trim();
      var clearBtn = document.getElementById('btn-clear-content');
      if (clearBtn) clearBtn.style.display = query ? 'inline-block' : 'none';

      try {
        var state = vscode.getState() || {};
        state.contentSearchQuery = rawVal;
        vscode.setState(state);
        vscode.postMessage({
          command: 'searchStateChanged',
          contentQuery: rawVal,
          isFocused: true
        });
      } catch (e) {}

      if (contentSearchDebounceTimer) {
        clearTimeout(contentSearchDebounceTimer);
        contentSearchDebounceTimer = null;
      }

      if (!query) {
        clearContentSearchResultsOnly();
        return;
      }

      var searchLbl = document.getElementById('btn-search-content-label');
      if (searchLbl) searchLbl.innerHTML = '<span class="node-btn-spinner"></span>';

      // 380ms debounce so user can finish typing word/phrase before launching disk search
      contentSearchDebounceTimer = setTimeout(function() {
        executeContentSearch();
      }, 380);
    }

    function executeContentSearch() {
      if (contentSearchDebounceTimer) {
        clearTimeout(contentSearchDebounceTimer);
        contentSearchDebounceTimer = null;
      }
      var input = document.getElementById('search-content-input');
      var rawVal = input ? input.value : '';
      var query = rawVal.trim();
      if (!query) {
        clearContentSearch();
        return;
      }

      currentContentSearchQuery = query;
      var clearBtn = document.getElementById('btn-clear-content');
      if (clearBtn) clearBtn.style.display = 'inline-block';

      var searchLbl = document.getElementById('btn-search-content-label');
      if (searchLbl) searchLbl.innerHTML = '<span class="node-btn-spinner"></span>';

      var btnWs = document.getElementById('btn-scope-workspace');
      var activeScope = (btnWs && btnWs.classList.contains('active')) ? 'workspace' : 'all';

      vscode.postMessage({
        command: 'searchContent',
        query: query,
        scope: activeScope
      });
    }

    function clearContentSearchResultsOnly() {
      currentContentSearchQuery = '';
      var resultsArea = document.getElementById('content-search-results-area');
      if (resultsArea) resultsArea.style.display = 'none';

      var resultsList = document.getElementById('content-search-results-list');
      if (resultsList) resultsList.innerHTML = '';

      var searchBtn = document.getElementById('btn-search-content');
      var searchLbl = document.getElementById('btn-search-content-label');
      if (searchBtn) searchBtn.disabled = false;
      if (searchLbl) searchLbl.innerHTML = '🔍 Find';

      // Restore scope views
      var btnWs = document.getElementById('btn-scope-workspace');
      var isWs = (btnWs && btnWs.classList.contains('active'));
      var viewWs = document.getElementById('scope-workspace-view');
      var viewAll = document.getElementById('scope-all-view');
      if (viewWs) viewWs.style.display = isWs ? 'flex' : 'none';
      if (viewAll) viewAll.style.display = isWs ? 'none' : 'flex';

      if (activeTitleFilter) {
        handleTitleSearch(activeTitleFilter);
      }
    }

    function clearContentSearch() {
      if (contentSearchDebounceTimer) {
        clearTimeout(contentSearchDebounceTimer);
        contentSearchDebounceTimer = null;
      }
      var input = document.getElementById('search-content-input');
      if (input) input.value = '';

      var clearBtn = document.getElementById('btn-clear-content');
      if (clearBtn) clearBtn.style.display = 'none';

      try {
        var state = vscode.getState() || {};
        state.contentSearchQuery = '';
        vscode.setState(state);
        vscode.postMessage({
          command: 'searchStateChanged',
          contentQuery: '',
          isFocused: false
        });
      } catch (e) {}

      clearContentSearchResultsOnly();
    }

    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (!msg) return;

      if (msg.command === 'conversationPreviewData') {
        renderConversationPreview(msg.data);
      }

      if (msg.command === 'tunnelStateChanged') {
        var input = document.getElementById('cf-tunnel-url');
        if (input && msg.url !== undefined) {
          input.value = msg.url;
        }
        var statusBadge = document.getElementById('cf-status-pill');
        if (statusBadge) {
          if (msg.isRunning) {
            statusBadge.className = 'remote-status-badge status-badge-connected';
            statusBadge.innerHTML = '🟢 Tunnel Live';
          } else {
            statusBadge.className = 'remote-status-badge status-badge-disconnected';
            statusBadge.innerHTML = '⚪ Offline';
          }
        }
        var qrWrap = document.getElementById('cf-qrcode-container');
        var qrBox = document.getElementById('qrcode-display-box');
        var magicA = document.getElementById('cf-magic-link-anchor');
        if (qrWrap) {
          if (msg.isRunning && msg.magicLink) {
            qrWrap.style.display = 'flex';
            if (qrBox && msg.qrSvg) qrBox.innerHTML = msg.qrSvg;
            if (magicA) {
              magicA.href = msg.magicLink;
              magicA.innerText = msg.magicLink;
            }
          } else {
            qrWrap.style.display = 'none';
          }
        }
        var btnLaunch = document.getElementById('btn-cf-launch');
        if (btnLaunch) {
          btnLaunch.disabled = false;
          if (msg.isRunning) {
            btnLaunch.innerHTML = '<span>🌐 Open in Browser (باز کردن در مرورگر)</span>';
          } else {
            btnLaunch.innerHTML = '<span>⚡ 1-Click Launch & Connect (اتصال خودکار)</span>';
          }
        }
        var btnStop = document.getElementById('btn-cf-stop');
        if (btnStop) {
          btnStop.style.display = msg.isRunning ? 'inline-flex' : 'none';
          btnStop.disabled = false;
          btnStop.innerHTML = '<span>🛑 Stop</span>';
        }
      }

      if (msg.command === 'contentSearchResults') {
        var input = document.getElementById('search-content-input');
        var currentVal = (input ? input.value : '').trim();
        // Ignore stale async results if user edited query in the meantime
        if (currentVal && msg.query !== currentVal) {
          return;
        }

        var searchBtn = document.getElementById('btn-search-content');
        var searchLbl = document.getElementById('btn-search-content-label');
        if (searchBtn) searchBtn.disabled = false;
        if (searchLbl) searchLbl.innerHTML = '🔍 Find';

        renderContentSearchResults(msg.query, msg.results || []);
      }
    });

    function renderContentSearchResults(query, results) {
      var resultsArea = document.getElementById('content-search-results-area');
      var queryBadge = document.getElementById('content-search-query-badge');
      var countBadge = document.getElementById('content-search-count-badge');
      var resultsList = document.getElementById('content-search-results-list');

      // Hide workspace / all views while viewing content search results
      var viewWs = document.getElementById('scope-workspace-view');
      var viewAll = document.getElementById('scope-all-view');
      if (viewWs) viewWs.style.display = 'none';
      if (viewAll) viewAll.style.display = 'none';

      if (queryBadge) queryBadge.innerText = '"' + query + '"';
      if (countBadge) countBadge.innerText = results.length + ' Chats found';
      if (resultsArea) resultsArea.style.display = 'flex';

      if (!results || results.length === 0) {
        if (resultsList) {
          resultsList.innerHTML = '<div style="opacity: 0.75; text-align: center; padding: 24px 12px; font-size: 11px; background: rgba(0,0,0,0.2); border-radius: 8px;">No conversation transcripts matched "<b>' + escapeHtml(query) + '</b>"</div>';
        }
        return;
      }

      var qRegex = new RegExp('(' + escapeRegex(query) + ')', 'gi');
      var html = '';

      results.forEach(function(item, idx) {
        var s = item.session;
        var escapedTitle = escapeHtml(s.title || 'Untitled Session');
        var highlightedTitle = escapedTitle.replace(qRegex, '<mark class="search-highlight">$1</mark>');

        var snippetsHtml = '';
        if (item.snippets && item.snippets.length > 0) {
          snippetsHtml = '<div class="search-snippets-wrap">' +
            item.snippets.map(function(snip) {
              var roleClass = snip.role === 'user' ? 'role-user' : snip.role === 'system' ? 'role-system' : 'role-assistant';
              var roleLabel = snip.role === 'user' ? 'User' : snip.role === 'system' ? 'System' : 'Agent';
              var escapedText = escapeHtml(snip.text).replace(qRegex, '<mark class="search-highlight">$1</mark>');
              var rtlClass = snip.isRtl ? ' is-rtl' : ' is-ltr';
              var dirAttr = snip.isRtl ? ' dir="rtl"' : ' dir="ltr"';
              return '<div class="search-snippet-item' + rtlClass + '"' + dirAttr + '>' +
                '<span class="search-snippet-role ' + roleClass + '">' + roleLabel + '</span>' +
                '<span class="search-snippet-text">' + escapedText + '</span>' +
              '</div>';
            }).join('') +
            '</div>';
        }

        html += '<div class="timeline-node" data-session-id="' + s.id + '" onclick="handleOpenChatNode(this)">' +
          '<div class="node-bullet"><span class="node-num">' + (idx + 1) + '</span></div>' +
          '<div class="node-content">' +
            '<div class="node-header">' +
              '<span class="node-title" title="' + escapedTitle + '">' + highlightedTitle + '</span>' +
              '<span class="node-token-tag" style="background: rgba(20, 184, 166, 0.2); border-color: var(--seafoam);">' + item.matchCount + (item.matchCount === 1 ? ' hit' : ' hits') + '</span>' +
            '</div>' +
            snippetsHtml +
            '<div class="node-footer">' +
              '<div class="node-meta-left">' +
                '<span class="node-date-tag date-today">' + s.dateFormatted + '</span>' +
                '<span class="node-steps-tag">' + s.stepCount + ' Steps</span>' +
                (s.projectName ? '<span class="node-steps-tag" style="color: var(--seafoam-light);">📁 ' + escapeHtml(s.projectName) + '</span>' : '') +
              '</div>' +
              '<div class="node-footer-btns" style="display: inline-flex; gap: 4px; align-items: center;">' +
                '<button type="button" class="node-open-btn node-preview-btn" onclick="event.stopPropagation(); previewSessionNode(this)" title="Preview conversation & artifacts in modal" style="background: rgba(56, 189, 248, 0.12); border-color: rgba(56, 189, 248, 0.35); color: #38bdf8;"><span>👁️ Preview</span></button>' +
                '<button type="button" class="node-open-btn" id="btn-open-' + s.id + '" onclick="event.stopPropagation(); handleOpenChatNode(this)" title="Open in Antigravity Chat panel">' +
                  '<svg class="node-btn-svg" viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2v3.5L8.5 11H14a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9H8.2L6 11.2V10H2V2h12v8z"/></svg> <span>Open in Chat</span>' +
                '</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      });

      if (resultsList) resultsList.innerHTML = html;
    }

    function switchChatScope(scope) {
      var isWs = scope === 'workspace';
      var btnWs = document.getElementById('btn-scope-workspace');
      var btnAll = document.getElementById('btn-scope-all');
      var viewWs = document.getElementById('scope-workspace-view');
      var viewAll = document.getElementById('scope-all-view');
      var resultsArea = document.getElementById('content-search-results-area');

      if (btnWs) btnWs.classList.toggle('active', isWs);
      if (btnAll) btnAll.classList.toggle('active', !isWs);

      if (currentContentSearchQuery) {
        executeContentSearch();
      } else {
        if (resultsArea) resultsArea.style.display = 'none';
        if (viewWs) viewWs.style.display = isWs ? 'flex' : 'none';
        if (viewAll) viewAll.style.display = isWs ? 'none' : 'flex';
        if (activeTitleFilter) {
          handleTitleSearch(activeTitleFilter);
        }
      }
    }

    function triggerAutoRecoverChats() {
      var btn = document.getElementById('btn-recover-chats');
      if (btn) {
        btn.classList.add('loading');
        btn.innerHTML = '<span>⏳ ریکاوری...</span>';
      }
      vscode.postMessage({ command: 'autoRecoverChats' });
    }

    // Live countdown timer script ticking every 1 second in DOM
    setInterval(() => {
      const now = Date.now();
      const pad = (n) => (n < 10 ? '0' + n : '' + n);

      // 1. Quota group cards (when viewing 5h window)
      if (currentQuotaWindow === '5h') {
        const cards = document.querySelectorAll('.quota-group-card');
        cards.forEach((card, idx) => {
          const resetMs = parseInt(card.getAttribute('data-reset-ms'), 10);
          if (isNaN(resetMs) || resetMs <= 0) return;

          const diff = Math.max(0, resetMs - now);
          const totalSeconds = Math.floor(diff / 1000);
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);

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
      }

      // 2. Switchboard account rows (live ticking second by second)
      const pills = document.querySelectorAll('.compact-reset-pill[data-reset-ms], .pill-depleted-wait[data-reset-ms]');
      pills.forEach((pill) => {
        const resetMs = parseInt(pill.getAttribute('data-reset-ms'), 10);
        if (isNaN(resetMs) || resetMs <= 0) return;

        const diff = Math.max(0, resetMs - now);
        if (diff <= 0) {
          pill.innerText = '✓ Ready';
          pill.style.color = '#10b981';
          pill.style.borderColor = 'rgba(16, 185, 129, 0.3)';
          return;
        }

        const totalSeconds = Math.floor(diff / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);

        let formatted = '';
        if (days > 0) {
          formatted = days + 'd ' + pad(hours) + 'h';
        } else if (hours > 0) {
          formatted = pad(hours) + 'h ' + pad(minutes) + 'm';
        } else {
          formatted = pad(minutes) + 'm';
        }

        pill.innerText = '⏳ ' + formatted;
        pill.title = 'Resets in ' + formatted;
      });
    }, 1000);

    // Restore saved search query and bind focus listeners to prevent UI blinks while typing
    try {
      var savedState = vscode.getState();
      var cInput = document.getElementById('search-content-input');
      var tInput = document.getElementById('search-titles-input');
      if (savedState) {
        if (savedState.contentSearchQuery && cInput) {
          cInput.value = savedState.contentSearchQuery;
          var clearBtnC = document.getElementById('btn-clear-content');
          if (clearBtnC) clearBtnC.style.display = 'inline-block';
          setTimeout(function() {
            executeContentSearch();
          }, 120);
        }
        if (savedState.titleSearchQuery && tInput) {
          tInput.value = savedState.titleSearchQuery;
          var clearBtnT = document.getElementById('btn-clear-title');
          if (clearBtnT) clearBtnT.style.display = 'inline-block';
          setTimeout(function() {
            activeTitleFilter = (savedState.titleSearchQuery || '').trim();
            applyTitleFilter(activeTitleFilter);
          }, 80);
        }
      }

      if (cInput) {
        cInput.addEventListener('focus', function() {
          vscode.postMessage({ command: 'searchStateChanged', isFocused: true, contentQuery: cInput.value });
        });
        cInput.addEventListener('blur', function() {
          setTimeout(function() {
            var activeEl = document.activeElement;
            var stillFocused = activeEl && (activeEl.id === 'search-content-input' || activeEl.id === 'search-titles-input');
            if (!stillFocused) {
              vscode.postMessage({ command: 'searchStateChanged', isFocused: false, contentQuery: cInput.value });
            }
          }, 200);
        });
      }

      if (tInput) {
        tInput.addEventListener('focus', function() {
          vscode.postMessage({ command: 'searchStateChanged', isFocused: true, titleQuery: tInput.value });
        });
        tInput.addEventListener('blur', function() {
          setTimeout(function() {
            var activeEl = document.activeElement;
            var stillFocused = activeEl && (activeEl.id === 'search-content-input' || activeEl.id === 'search-titles-input');
            if (!stillFocused) {
              vscode.postMessage({ command: 'searchStateChanged', isFocused: false, titleQuery: tInput.value });
            }
          }, 200);
        });
      }
    } catch (e) {}

    /* ==========================================================================
       Cyber-Glass Conversation & Brain Preview Modal Controller
       ========================================================================== */
    var activePreviewData = null;
    var activeModalTab = 'turns';

    function isRtlText(str) {
      if (!str) return false;
      return new RegExp('[\\\\u0600-\\\\u06FF\\\\uFB50-\\\\uFDFF\\\\uFE70-\\\\uFEFF]').test(str);
    }

    function formatMarkdown(text) {
      if (!text) return '';
      var escaped = escapeHtml(text);

      // Fenced code blocks
      var codeBlockRe = new RegExp('\\x60\\x60\\x60([a-zA-Z0-9_\\-\\.\\+]*)\\n([\\s\\S]*?)\\x60\\x60\\x60', 'g');
      escaped = escaped.replace(codeBlockRe, function(match, lang, code) {
        var cleanLang = (lang || 'code').trim();
        return '<div class="conv-code-box">' +
          '<div class="conv-code-header">' +
            '<span class="conv-code-lang">' + cleanLang + '</span>' +
            '<button type="button" class="conv-copy-btn" onclick="copyCodeBlock(this)">Copy</button>' +
          '</div>' +
          '<pre><code>' + code + '</code></pre>' +
        '</div>';
      });

      // Inline code
      var inlineCodeRe = new RegExp('\\x60([^\\x60\\n]+)\\x60', 'g');
      escaped = escaped.replace(inlineCodeRe, '<code class="conv-inline-code">$1</code>');

      // Bold & Italic
      escaped = escaped.replace(new RegExp('\\*\\*\\*([^*]+)\\*\\*\\*', 'g'), '<strong><em>$1</em></strong>');
      escaped = escaped.replace(new RegExp('\\*\\*([^*]+)\\*\\*', 'g'), '<strong>$1</strong>');
      escaped = escaped.replace(new RegExp('\\*([^*]+)\\*', 'g'), '<em>$1</em>');

      // Headers
      escaped = escaped.replace(new RegExp('^### (.*$)', 'gim'), '<h4 class="conv-md-h4">$1</h4>');
      escaped = escaped.replace(new RegExp('^## (.*$)', 'gim'), '<h3 class="conv-md-h3">$1</h3>');
      escaped = escaped.replace(new RegExp('^# (.*$)', 'gim'), '<h2 class="conv-md-h2">$1</h2>');

      // Blockquotes
      escaped = escaped.replace(new RegExp('^>\\\\s?(.*$)', 'gim'), '<blockquote class="conv-md-quote">$1</blockquote>');

      // Lists
      escaped = escaped.replace(new RegExp('^[\\*\\-]\\\\s+(.*$)', 'gim'), '<div class="conv-md-li"><span class="conv-bullet">•</span><span>$1</span></div>');
      escaped = escaped.replace(new RegExp('^(\\\\d+)\\\\.\\\\s+(.*$)', 'gim'), '<div class="conv-md-li"><span class="conv-num-bullet">$1.</span><span>$2</span></div>');

      // Horizontal rules
      escaped = escaped.replace(new RegExp('^---$', 'gim'), '<hr class="conv-md-hr"/>');

      // Preserve paragraphs outside code blocks
      var parts = escaped.split(new RegExp('(<div class="conv-code-box">[\\\\s\\\\S]*?</div>)', 'g'));
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i].startsWith('<div class="conv-code-box">')) {
          parts[i] = parts[i].replace(new RegExp('\\\\n{2,}', 'g'), '<div class="conv-md-gap"></div>');
          parts[i] = parts[i].replace(new RegExp('\\\\n', 'g'), '<br/>');
        }
      }
      return parts.join('');
    }

    function previewSession(sessionId) {
      if (!sessionId) return;
      var modal = document.getElementById('conversation-preview-modal');
      var modalBody = document.getElementById('conv-modal-body');
      var modalTitle = document.getElementById('conv-modal-title');
      var modalSub = document.getElementById('conv-modal-sub');
      var modalTabs = document.getElementById('conv-modal-tabs');

      if (modal) modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';

      if (modalTitle) modalTitle.innerText = 'Loading Conversation...';
      if (modalSub) modalSub.innerHTML = '';
      if (modalTabs) {
        modalTabs.innerHTML = '';
        modalTabs.style.display = 'none';
      }
      if (modalBody) {
        modalBody.innerHTML =
          '<div class="conv-loading-shimmer">' +
            '<div class="conv-shimmer-spinner"></div>' +
            '<div>Reading brain artifacts & conversation logs...</div>' +
          '</div>';
      }

      vscode.postMessage({ command: 'getConversationPreview', sessionId: sessionId });
    }

    function previewSessionNode(el) {
      var node = (el && el.closest) ? (el.closest('.timeline-node') || el) : el;
      var sid = node ? node.getAttribute('data-session-id') : '';
      if (sid) previewSession(sid);
    }

    function closeConversationPreview() {
      var modal = document.getElementById('conversation-preview-modal');
      if (modal) modal.style.display = 'none';
      document.body.style.overflow = '';
      activePreviewData = null;
    }

    function handleModalBackdropClick(e) {
      if (e.target && e.target.id === 'conversation-preview-modal') {
        closeConversationPreview();
      }
    }

    function toggleThought(headerEl) {
      var container = headerEl.parentElement;
      var content = container.querySelector('.conv-thought-body');
      var chevron = headerEl.querySelector('.conv-thought-chevron');
      if (!content) return;
      if (content.style.display === 'none') {
        content.style.display = 'block';
        if (chevron) chevron.style.transform = 'rotate(90deg)';
      } else {
        content.style.display = 'none';
        if (chevron) chevron.style.transform = 'rotate(0deg)';
      }
    }

    function copyCodeBlock(btn) {
      var box = btn.closest('.conv-code-box');
      if (!box) return;
      var codeEl = box.querySelector('code');
      if (!codeEl) return;
      var text = codeEl.innerText || codeEl.textContent;
      navigator.clipboard.writeText(text).then(function() {
        var orig = btn.innerText;
        btn.innerText = 'Copied!';
        btn.style.color = '#38bdf8';
        setTimeout(function() {
          btn.innerText = orig;
          btn.style.color = '';
        }, 1500);
      });
    }

    function openModalBrainFolder(sessionId) {
      vscode.postMessage({ command: 'openBrainFolder', sessionId: sessionId });
    }

    function openModalTranscript(sessionId) {
      vscode.postMessage({ command: 'openTranscript', sessionId: sessionId });
    }

    function openModalChat(sessionId) {
      closeConversationPreview();
      var btn = document.getElementById('btn-open-' + sessionId);
      if (btn) {
        handleOpenChat(btn, sessionId);
      } else {
        vscode.postMessage({ command: 'openConversation', sessionId: sessionId });
      }
    }

    function openArtifactByIndex(idx) {
      if (activePreviewData && activePreviewData.artifacts && activePreviewData.artifacts[idx]) {
        var filePath = activePreviewData.artifacts[idx].fullPath;
        vscode.postMessage({ command: 'openArtifact', filePath: filePath });
      }
    }

    function renderConversationPreview(data) {
      if (!data) return;
      activePreviewData = data;
      activeModalTab = 'turns';

      var modalTitle = document.getElementById('conv-modal-title');
      var modalSub = document.getElementById('conv-modal-sub');
      var btnFolder = document.getElementById('conv-btn-folder');
      var btnLog = document.getElementById('conv-btn-log');
      var btnChat = document.getElementById('conv-btn-chat');
      var modalTabs = document.getElementById('conv-modal-tabs');

      if (modalTitle) modalTitle.innerText = data.title || 'Conversation Preview';

      if (modalSub) {
        var subHtml = '';
        if (data.dateFormatted) {
          subHtml += '<span class="conv-badge badge-date">' + escapeHtml(data.dateFormatted) + '</span>';
        }
        if (data.stepCount) {
          subHtml += '<span class="conv-badge">' + data.stepCount + ' Steps</span>';
        }
        if (data.tokenEstimate) {
          subHtml += '<span class="conv-badge">' + (Math.round(data.tokenEstimate / 100) / 10) + 'k tok</span>';
        }
        if (data.projectName) {
          subHtml += '<span class="conv-badge badge-project">📁 ' + escapeHtml(data.projectName) + '</span>';
        }
        modalSub.innerHTML = subHtml;
      }

      if (btnFolder) {
        btnFolder.onclick = function() { openModalBrainFolder(data.sessionId); };
      }
      if (btnLog) {
        btnLog.onclick = function() { openModalTranscript(data.sessionId); };
      }
      if (btnChat) {
        btnChat.onclick = function() { openModalChat(data.sessionId); };
      }

      // Render Tabs if artifacts exist
      if (modalTabs) {
        if (data.artifacts && data.artifacts.length > 0) {
          var turnsCount = (data.turns && data.turns.length) || 0;
          var tabsHtml = '<button type="button" class="conv-tab-btn active" id="conv-tab-turns" data-modaltab="turns">💬 Chat Turns (' + turnsCount + ')</button>';
          for (var aIdx = 0; aIdx < data.artifacts.length; aIdx++) {
            var art = data.artifacts[aIdx];
            tabsHtml += '<button type="button" class="conv-tab-btn" id="conv-tab-art-' + aIdx + '" data-modaltab="art-' + aIdx + '">📋 ' + escapeHtml(art.name) + '</button>';
          }
          modalTabs.innerHTML = tabsHtml;
          modalTabs.style.display = 'flex';
        } else {
          modalTabs.innerHTML = '';
          modalTabs.style.display = 'none';
        }
      }

      renderModalBody();
    }

    function switchModalTab(tabId) {
      activeModalTab = tabId;
      var tabs = document.querySelectorAll('.conv-tab-btn');
      tabs.forEach(function(t) {
        t.classList.remove('active');
      });
      var activeBtn = document.getElementById('conv-tab-' + tabId);
      if (activeBtn) activeBtn.classList.add('active');

      renderModalBody();
    }

    function renderModalBody() {
      var modalBody = document.getElementById('conv-modal-body');
      if (!modalBody || !activePreviewData) return;

      if (activeModalTab === 'turns') {
        var turns = activePreviewData.turns || [];
        if (turns.length === 0) {
          modalBody.innerHTML =
            '<div style="text-align: center; padding: 30px 10px; color: #94a3b8; font-size: 11.5px;">' +
              '<div>No prompt or response logs recorded in this brain session yet.</div>' +
              '<div style="margin-top: 10px;">' +
                '<button type="button" class="conv-action-btn" id="conv-btn-open-raw">Open Raw Log File</button>' +
              '</div>' +
            '</div>';
          return;
        }

        var html = '';
        for (var i = 0; i < turns.length; i++) {
          var turn = turns[i];
          var isUser = turn.role === 'user';
          var isRtl = isRtlText(turn.content || turn.thought || '');

          html += '<div class="conv-turn ' + (isUser ? 'conv-turn-user' : 'conv-turn-assistant') + ' ' + (isRtl ? 'is-rtl' : '') + '">';
          html += '<div class="conv-turn-header">';
          html += '<span class="conv-role-badge ' + (isUser ? 'conv-role-user' : 'conv-role-assistant') + '">' + (isUser ? 'User' : 'Assistant') + '</span>';
          if (turn.timestamp) {
            var timeStr = turn.timestamp.split('T')[1] ? turn.timestamp.split('T')[1].slice(0, 8) : turn.timestamp;
            html += '<span class="conv-turn-time">' + escapeHtml(timeStr) + '</span>';
          }
          html += '</div>';

          // Thinking dropdown
          if (turn.thought) {
            html += '<div class="conv-thought-box">';
            html += '<div class="conv-thought-header" onclick="toggleThought(this)">';
            html += '<span>🧠 Thought Process</span>';
            html += '<span class="conv-thought-chevron">›</span>';
            html += '</div>';
            html += '<div class="conv-thought-body" style="display: none;">' + formatMarkdown(turn.thought) + '</div>';
            html += '</div>';
          }

          // Tool calls
          if (turn.toolCalls && turn.toolCalls.length > 0) {
            html += '<div class="conv-tools-row">';
            for (var tIdx = 0; tIdx < turn.toolCalls.length; tIdx++) {
              html += '<span class="conv-tool-pill">⚙ ' + escapeHtml(turn.toolCalls[tIdx]) + '</span>';
            }
            html += '</div>';
          }

          // Main response content
          html += '<div class="conv-turn-content">' + formatMarkdown(turn.content) + '</div>';
          html += '</div>';
        }

        modalBody.innerHTML = html;
        modalBody.scrollTop = 0;
      } else if (activeModalTab.startsWith('art-')) {
        var artIdx = parseInt(activeModalTab.replace('art-', ''), 10);
        var art = activePreviewData.artifacts && activePreviewData.artifacts[artIdx];
        if (!art) return;

        var kb = Math.round((art.sizeBytes / 1024) * 10) / 10;
        var html = '<div class="conv-artifact-bar">';
        html += '<span>📄 <b>' + escapeHtml(art.name) + '</b> (' + kb + ' KB)</span>';
        html += '<button type="button" class="conv-mini-btn" onclick="openArtifactByIndex(' + artIdx + ')">Open in Editor</button>';
        html += '</div>';
        html += '<div class="conv-artifact-content ' + (isRtlText(art.previewContent) ? 'is-rtl' : '') + '">' + formatMarkdown(art.previewContent) + '</div>';

        modalBody.innerHTML = html;
        modalBody.scrollTop = 0;
      }
    }

    // Keyboard shortcut: close preview modal on Escape
    window.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        closeConversationPreview();
      }
    });

    /* ==========================================================================
       Tab 3: Remote Control & Auto-Approve Action Handlers
       ========================================================================== */
    var autoSaveTimer = null;
    function autoSaveTelegramInput() {
      // Persist immediately in sessionStorage
      try {
        var b = document.getElementById('tg-bot-token');
        var c = document.getElementById('tg-chat-id');
        var f = document.getElementById('tg-forum-id');
        if (b) sessionStorage.setItem('ag_draft_tg_bot', b.value);
        if (c) sessionStorage.setItem('ag_draft_tg_chat', c.value);
        if (f) sessionStorage.setItem('ag_draft_tg_forum', f.value);
      } catch (e) {}

      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(function() {
        saveTelegramSettings(true);
      }, 350);
    }

    // Restore drafts if present
    window.addEventListener('DOMContentLoaded', function() {
      try {
        var b = document.getElementById('tg-bot-token');
        var c = document.getElementById('tg-chat-id');
        var f = document.getElementById('tg-forum-id');
        var sB = sessionStorage.getItem('ag_draft_tg_bot');
        var sC = sessionStorage.getItem('ag_draft_tg_chat');
        var sF = sessionStorage.getItem('ag_draft_tg_forum');
        if (b && !b.value && sB) b.value = sB;
        if (c && !c.value && sC) c.value = sC;
        if (f && !f.value && sF) f.value = sF;
      } catch (e) {}
    });

    function saveTelegramSettings(silent) {
      var botTokenInput = document.getElementById('tg-bot-token');
      var chatIdInput = document.getElementById('tg-chat-id');
      var forumIdInput = document.getElementById('tg-forum-id');
      var notifyCompleteInput = document.getElementById('tg-notify-complete');
      var notifyInputInput = document.getElementById('tg-notify-input');
      var notifyErrorInput = document.getElementById('tg-notify-error');

      var botToken = botTokenInput ? botTokenInput.value.trim() : '';
      var chatId = chatIdInput ? chatIdInput.value.trim() : '';
      var forumSupergroupId = forumIdInput ? forumIdInput.value.trim() : '';
      var notifyComplete = notifyCompleteInput ? notifyCompleteInput.checked : true;
      var notifyInput = notifyInputInput ? notifyInputInput.checked : true;
      var notifyError = notifyErrorInput ? notifyErrorInput.checked : true;

      vscode.postMessage({
        command: 'saveTelegramConfig',
        silent: Boolean(silent),
        config: {
          enabled: Boolean(botToken && (chatId || forumSupergroupId)),
          botToken: botToken,
          chatId: chatId,
          forumSupergroupId: forumSupergroupId,
          notifyOnCompletion: notifyComplete,
          notifyOnNeedInput: notifyInput,
          notifyOnError: notifyError
        }
      });
    }

    function sendTestTelegramAlert() {
      vscode.postMessage({ command: 'testTelegramAlert' });
    }

    function generateTelegramPairCode() {
      vscode.postMessage({ command: 'generatePairingCode' });
    }

    function startCloudflareTunnel() {
      var btn = document.getElementById('btn-cf-launch');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span>⏳ Starting Tunnel & Opening Browser...</span>';
      }
      vscode.postMessage({ command: 'startCloudflareTunnel' });
    }

    function stopCloudflareTunnel() {
      var btnStop = document.getElementById('btn-cf-stop');
      if (btnStop) {
        btnStop.disabled = true;
        btnStop.innerHTML = '<span>⏳ Stopping...</span>';
      }
      vscode.postMessage({ command: 'stopCloudflareTunnel' });
    }

    function sendTunnelLinkToTelegram() {
      vscode.postMessage({ command: 'sendTunnelLinkToTelegram' });
    }

    function savePolicySettings() {
      var enabledInput = document.getElementById('policy-enabled');
      var readsInput = document.getElementById('policy-reads');
      var writesInput = document.getElementById('policy-writes');
      var commandsInput = document.getElementById('policy-commands');
      var cbInput = document.getElementById('policy-circuit-breaker');
      var wlInput = document.getElementById('policy-whitelist');
      var maxFInput = document.getElementById('policy-max-failures');
      var maxTInput = document.getElementById('policy-max-tokens');

      var enabled = enabledInput ? enabledInput.checked : true;
      var reads = readsInput ? readsInput.checked : true;
      var writes = writesInput ? writesInput.checked : true;
      var commands = commandsInput ? commandsInput.checked : true;
      var cb = cbInput ? cbInput.checked : true;
      var wlRaw = wlInput ? wlInput.value.trim() : '';
      var maxF = parseInt(maxFInput ? maxFInput.value : '3', 10);
      var maxT = parseInt(maxTInput ? maxTInput.value : '150000', 10);

      var wlList = wlRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean);

      vscode.postMessage({
        command: 'saveAutoApprovePolicy',
        policy: {
          enabled: enabled,
          autoApproveReads: reads,
          autoApproveWorkspaceWrites: writes,
          autoApproveSafeCommands: commands,
          zeroTokenWasteCircuitBreaker: cb,
          commandWhitelist: wlList,
          maxConsecutiveFailures: isNaN(maxF) ? 3 : maxF,
          maxTokensPerTask: isNaN(maxT) ? 150000 : maxT
        }
      });
    }

    function resetPolicySettings() {
      vscode.postMessage({ command: 'resetAutoApprovePolicy' });
    }
  </script>
</body>
</html>`;
  }

  private renderLoadingSkeleton(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Shield</title>
  <style>
    :root {
      --bg-base: #090d16;
      --bg-card: rgba(15, 23, 42, 0.65);
      --border-card: rgba(255, 255, 255, 0.08);
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --cyan-glow: #06b6d4;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-base);
      color: var(--text-primary);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 12px;
      overflow-x: hidden;
      user-select: none;
    }
    .header-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: var(--bg-card);
      border: 1px solid var(--border-card);
      border-radius: 12px;
      margin-bottom: 12px;
      backdrop-filter: blur(12px);
    }
    .brand-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--cyan-glow);
      box-shadow: 0 0 8px var(--cyan-glow);
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    .skeleton-box {
      background: linear-gradient(90deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.03) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.8s infinite;
      border-radius: 10px;
    }
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .skeleton-account {
      height: 48px;
      margin-bottom: 12px;
    }
    .skeleton-tabs {
      height: 36px;
      margin-bottom: 14px;
    }
    .skeleton-card {
      height: 120px;
      margin-bottom: 12px;
      border: 1px solid var(--border-card);
    }
    .loading-msg {
      text-align: center;
      font-size: 11px;
      color: var(--text-secondary);
      margin-top: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
  </style>
</head>
<body>
  <div class="header-bar">
    <div class="brand-title">
      <div class="pulse-dot"></div>
      <span>ANTIGRAVITY SHIELD</span>
    </div>
    <span style="font-size: 10px; color: var(--text-secondary); text-transform: uppercase;">Connecting</span>
  </div>
  <div class="skeleton-box skeleton-account"></div>
  <div class="skeleton-box skeleton-tabs"></div>
  <div class="skeleton-box skeleton-card"></div>
  <div class="skeleton-box skeleton-card"></div>
  <div class="loading-msg">
    <span>Synchronizing live AI quota telemetry & accounts...</span>
  </div>
</body>
</html>`;
  }

  private renderErrorFallback(errMsg: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Antigravity Shield</title>
  <style>
    body {
      background-color: #090d16;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 80vh;
      text-align: center;
    }
    .error-card {
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: 12px;
      padding: 20px;
      max-width: 320px;
      width: 100%;
    }
    .error-icon { font-size: 32px; margin-bottom: 8px; }
    .error-title { font-size: 14px; font-weight: 700; color: #f87171; margin-bottom: 6px; }
    .error-desc { font-size: 11px; color: #94a3b8; margin-bottom: 16px; line-height: 1.4; word-break: break-word; }
    .btn-retry {
      background: #0891b2;
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-retry:hover { background: #06b6d4; }
  </style>
</head>
<body>
  <div class="error-card">
    <div class="error-icon">⚠️</div>
    <div class="error-title">Initialization Delayed</div>
    <div class="error-desc">${errMsg || 'Could not load quota telemetry.'}</div>
    <button class="btn-retry" onclick="vscode.postMessage({ command: 'refresh' })">
      <span>🔄 Reload Telemetry</span>
    </button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
  </script>
</body>
</html>`;
  }
}
