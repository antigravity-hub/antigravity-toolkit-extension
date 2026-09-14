import * as vscode from 'vscode';
import { QuotaService } from '../services/quotaService';
import { AccountService } from '../services/accountService';
import { AutoSwitchService } from '../services/autoSwitchService';
import { Account, ModelQuota } from '../types';

export class QuotaWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravity.views.quota';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly quotaService: QuotaService,
    private readonly accountService: AccountService,
    private readonly autoSwitchService: AutoSwitchService
  ) {
    this.quotaService.onDidChangeQuotas(() => this.updateWebview());
    this.accountService.onDidChangeAccounts(() => this.updateWebview());
    this.autoSwitchService.onDidChangeStatus(() => this.updateWebview());
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

    this._view.webview.html = this.renderHtml(activeAccount, quotas, accounts, autoSwitchStatus);
  }

  private renderHtml(
    activeAccount: Account | undefined,
    quotas: ModelQuota[],
    accounts: Account[],
    autoSwitchStatus: { enabled: boolean; thresholdPercent: number; cooldownMinutes: number }
  ): string {
    const activeEmail = activeAccount ? activeAccount.email : 'No active account';
    const activeTier = activeAccount ? activeAccount.tier || 'Google AI Pro' : 'Free';
    const activeHealth = activeAccount ? Math.round(this.accountService.getAccountHealth(activeAccount)) : 0;
    const isAutoOn = autoSwitchStatus.enabled;

    // Build Model Cards with Radial SVG Rings & Live Timers
    const quotaCardsHtml = quotas
      .map((q, idx) => {
        const remaining = Math.max(0, 100 - q.usagePercentage);
        const radius = 28;
        const circumference = 2 * Math.PI * radius;
        const strokeDashoffset = circumference - (remaining / 100) * circumference;

        let strokeColor = '#10b981'; // Emerald
        let glowColor = 'rgba(16, 185, 129, 0.4)';
        let badgeClass = 'badge-green';

        if (remaining <= 20) {
          strokeColor = '#f43f5e'; // Rose/Ruby
          glowColor = 'rgba(244, 63, 94, 0.4)';
          badgeClass = 'badge-red';
        } else if (remaining <= 50) {
          strokeColor = '#f59e0b'; // Amber
          glowColor = 'rgba(245, 158, 11, 0.4)';
          badgeClass = 'badge-yellow';
        } else if (remaining <= 80) {
          strokeColor = '#06b6d4'; // Cyan
          glowColor = 'rgba(6, 182, 212, 0.4)';
          badgeClass = 'badge-cyan';
        }

        return `
        <div class="model-bento-card" data-reset-ms="${q.resetTimeMs}">
          <div class="model-card-left">
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
                    filter: drop-shadow(0 0 6px ${glowColor});
                  "
                />
              </svg>
              <div class="radial-text">
                <span class="radial-percent">${remaining}%</span>
              </div>
            </div>
          </div>
          <div class="model-card-info">
            <div class="model-card-title-row">
              <span class="model-name">${q.displayName}</span>
              <span class="quota-badge ${badgeClass}">${remaining}% Left</span>
            </div>
            <div class="model-metrics-row">
              <span class="metric-label">Window:</span>
              <span class="metric-val">${q.windowType === 'rolling_5h' ? '5h Rolling' : 'Weekly'}</span>
            </div>
            <div class="model-metrics-row">
              <span class="metric-label">Resets in:</span>
              <span class="metric-val countdown-text" id="countdown-${idx}">${q.resetTimeFormatted}</span>
            </div>
            <div class="linear-bar-bg">
              <div class="linear-bar-fill" style="width: ${remaining}%; background: ${strokeColor};"></div>
            </div>
          </div>
        </div>
      `;
      })
      .join('');

    // Build Switchboard Account Cards
    const accountCardsHtml = accounts
      .map((acc) => {
        const isActive = acc.isActive;
        const health = Math.round(this.accountService.getAccountHealth(acc));
        const initials = acc.email.slice(0, 2).toUpperCase();

        let healthColor = '#10b981';
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
              <span class="health-label">Quota Capacity</span>
              <span class="health-value" style="color: ${healthColor}; font-weight: 700;">${health}%</span>
            </div>
            <div class="mini-health-bar-bg">
              <div class="mini-health-bar-fill" style="width: ${health}%; background: ${healthColor};"></div>
            </div>
          </div>

          <div class="account-card-action">
            ${
              isActive
                ? `<button class="btn-account-active" disabled>
                    <span class="btn-check-icon">✓</span> Current Active Session
                   </button>`
                : `<button class="btn-switch-account" onclick="switchAccount('${acc.email}')">
                    <span class="btn-icon">⚡</span> Switch to Session
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
  <title>Antigravity Toolkit 2.0 HUD</title>
  <!-- Lottie Player for high-tech micro-animations -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"></script>
  <style>
    :root {
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      --bg-surface: #0a0d14;
      --card-bg: rgba(18, 24, 38, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --card-border-glow: rgba(14, 165, 233, 0.35);
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --accent-cyan: #06b6d4;
      --accent-emerald: #10b981;
      --accent-purple: #8b5cf6;
      --accent-amber: #f59e0b;
      --accent-ruby: #f43f5e;
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
      padding: 12px;
      overflow-x: hidden;
    }

    /* Double-bezel outer container */
    .hud-container {
      display: flex;
      flex-direction: column;
      gap: 14px;
      max-width: 100%;
    }

    /* Header Hero Island */
    .hero-island {
      position: relative;
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.9) 0%, rgba(10, 15, 29, 0.95) 100%);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 14px;
      overflow: hidden;
      box-shadow: 0 8px 24px -6px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(16px);
    }

    .hero-glow-orb {
      position: absolute;
      top: -30px;
      right: -30px;
      width: 120px;
      height: 120px;
      background: radial-gradient(circle, rgba(14, 165, 233, 0.25) 0%, rgba(139, 92, 246, 0.05) 70%, transparent 100%);
      border-radius: 50%;
      pointer-events: none;
      animation: orbFloat 6s ease-in-out infinite alternate;
    }

    @keyframes orbFloat {
      0% { transform: translate(0, 0) scale(1); }
      100% { transform: translate(-15px, 15px) scale(1.15); }
    }

    .hero-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .hero-brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-icon-reactor {
      width: 28px;
      height: 28px;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Inline Animated SVG Reactor (Lottie style) */
    .reactor-svg {
      animation: spinReactor 12s linear infinite;
    }

    @keyframes spinReactor {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .brand-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.04em;
      background: linear-gradient(90deg, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      text-transform: uppercase;
    }

    .hero-active-details {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .hero-email {
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      word-break: break-all;
    }

    .hero-meta-pills {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 2px;
    }

    .plan-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(14, 165, 233, 0.15);
      border: 1px solid rgba(14, 165, 233, 0.4);
      color: #38bdf8;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .health-pill {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #34d399;
    }

    /* Auto-Rotate Control Island */
    .auto-rotate-bar {
      background: rgba(15, 23, 42, 0.65);
      border: 1px solid ${isAutoOn ? 'rgba(16, 185, 129, 0.4)' : 'rgba(255, 255, 255, 0.08)'};
      border-radius: 12px;
      padding: 10px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: ${isAutoOn ? '0 0 16px -4px rgba(16, 185, 129, 0.25)' : 'none'};
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .auto-rotate-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /* Animated Radar Sweep Beacon */
    .radar-beacon {
      position: relative;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .radar-pulse-ring {
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: ${isAutoOn ? 'rgba(16, 185, 129, 0.35)' : 'rgba(148, 163, 184, 0.2)'};
      animation: ${isAutoOn ? 'pulseWave 2s cubic-bezier(0, 0.2, 0.8, 1) infinite' : 'none'};
    }

    @keyframes pulseWave {
      0% { transform: scale(0.6); opacity: 1; }
      100% { transform: scale(1.8); opacity: 0; }
    }

    .radar-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: ${isAutoOn ? '#10b981' : '#64748b'};
      box-shadow: ${isAutoOn ? '0 0 8px #10b981' : 'none'};
    }

    .auto-text-group {
      display: flex;
      flex-direction: column;
    }

    .auto-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: ${isAutoOn ? '#34d399' : '#94a3b8'};
    }

    .auto-desc {
      font-size: 10px;
      color: var(--text-muted);
    }

    .switch-toggle-btn {
      background: ${isAutoOn ? 'linear-gradient(135deg, #059669 0%, #10b981 100%)' : 'rgba(255,255,255,0.08)'};
      color: #fff;
      border: 1px solid ${isAutoOn ? '#34d399' : 'rgba(255,255,255,0.1)'};
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      transition: all 0.2s ease;
    }

    .switch-toggle-btn:hover {
      transform: scale(1.04);
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.4);
    }

    /* Section Headers */
    .section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 4px;
      margin-bottom: 2px;
    }

    .section-tag {
      font-size: 9px;
      background: rgba(255, 255, 255, 0.06);
      padding: 1px 6px;
      border-radius: 4px;
      color: #94a3b8;
    }

    /* Bento Model Cards with Radial SVG */
    .models-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .model-bento-card {
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 10px 12px;
      backdrop-filter: blur(10px);
      transition: transform 0.2s ease, border-color 0.2s ease;
    }

    .model-bento-card:hover {
      transform: translateY(-1px);
      border-color: rgba(255, 255, 255, 0.18);
    }

    .radial-container {
      position: relative;
      width: 60px;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .radial-svg {
      transform: rotate(-90deg);
      width: 60px;
      height: 60px;
    }

    .radial-bg {
      fill: none;
      stroke: rgba(255, 255, 255, 0.06);
      stroke-width: 5;
    }

    .radial-fill {
      fill: none;
      stroke-width: 5;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.8s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .radial-text {
      position: absolute;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }

    .radial-percent {
      font-size: 11px;
      font-weight: 700;
      color: #fff;
    }

    .model-card-info {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .model-card-title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .model-name {
      font-size: 12px;
      font-weight: 600;
      color: #f8fafc;
    }

    .quota-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 4px;
    }

    .badge-green {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
    }

    .badge-cyan {
      background: rgba(6, 182, 212, 0.15);
      color: #38bdf8;
    }

    .badge-yellow {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
    }

    .badge-red {
      background: rgba(244, 63, 94, 0.15);
      color: #fb7185;
    }

    .model-metrics-row {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--text-muted);
    }

    .metric-val {
      font-weight: 600;
      color: #cbd5e1;
    }

    .countdown-text {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #38bdf8;
    }

    .linear-bar-bg {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 3px;
    }

    .linear-bar-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.6s ease;
    }

    /* Switchboard Account Cards */
    .accounts-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .account-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .account-active-glow {
      border: 1px solid rgba(14, 165, 233, 0.5);
      box-shadow: 0 0 16px -4px rgba(14, 165, 233, 0.25);
      background: linear-gradient(135deg, rgba(14, 165, 233, 0.08) 0%, rgba(18, 24, 38, 0.9) 100%);
    }

    .account-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .account-avatar-wrapper {
      position: relative;
      width: 32px;
      height: 32px;
      flex-shrink: 0;
    }

    .account-avatar-img {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      object-fit: cover;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }

    .account-avatar-fallback {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1e293b, #334155);
      color: #38bdf8;
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .active-pulse-beacon {
      position: absolute;
      bottom: -1px;
      right: -1px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #10b981;
      border: 2px solid #0f172a;
      box-shadow: 0 0 6px #10b981;
    }

    .account-text-details {
      flex: 1;
      min-width: 0;
    }

    .account-email {
      font-size: 11.5px;
      font-weight: 600;
      color: #f1f5f9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .account-subrow {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 2px;
    }

    .tier-pill {
      font-size: 9px;
      background: rgba(255, 255, 255, 0.06);
      color: #cbd5e1;
      padding: 1px 5px;
      border-radius: 3px;
    }

    .status-pill {
      font-size: 9px;
      color: #94a3b8;
    }

    .account-health-row {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .health-meta {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--text-muted);
    }

    .mini-health-bar-bg {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.07);
      border-radius: 2px;
      overflow: hidden;
    }

    .mini-health-bar-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.4s ease;
    }

    .account-card-action button {
      width: 100%;
      border: none;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s ease;
    }

    .btn-switch-account {
      background: rgba(255, 255, 255, 0.08);
      color: #f1f5f9;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
    }

    .btn-switch-account:hover {
      background: rgba(14, 165, 233, 0.2);
      border-color: rgba(14, 165, 233, 0.4) !important;
      color: #38bdf8;
    }

    .btn-switch-account:active {
      transform: scale(0.98);
    }

    .btn-account-active {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3) !important;
      cursor: default;
    }

    /* Floating Action Dock */
    .dock-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-top: 4px;
    }

    .btn-dock {
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--card-border);
      color: #cbd5e1;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s ease;
    }

    .btn-dock:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      border-color: rgba(255, 255, 255, 0.2);
      transform: translateY(-1px);
    }

    .btn-dock:active {
      transform: scale(0.98);
    }

    .btn-dock.primary-action {
      grid-column: span 2;
      background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
      border: 1px solid #38bdf8;
      color: #fff;
      box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3);
    }

    .btn-dock.primary-action:hover {
      box-shadow: 0 4px 18px rgba(2, 132, 199, 0.5);
    }
  </style>
</head>
<body>
  <div class="hud-container">

    <!-- Active Hero Island -->
    <div class="hero-island">
      <div class="hero-glow-orb"></div>
      <div class="hero-header-row">
        <div class="hero-brand">
          <div class="brand-icon-reactor">
            <!-- Quantum Reactor Animated SVG -->
            <svg class="reactor-svg" width="26" height="26" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="42" stroke="#0ea5e9" stroke-width="4" fill="none" stroke-dasharray="180 80" />
              <circle cx="50" cy="50" r="30" stroke="#8b5cf6" stroke-width="4" fill="none" stroke-dasharray="120 70" />
              <circle cx="50" cy="50" r="14" fill="#38bdf8" />
            </svg>
          </div>
          <span class="brand-title">Antigravity HUD 2.0</span>
        </div>
        <div class="hero-meta-pills">
          <span class="health-pill">${activeHealth}% Ready</span>
        </div>
      </div>

      <div class="hero-active-details">
        <div class="hero-email">${activeEmail}</div>
        <div class="hero-meta-pills">
          <span class="plan-badge">⚡ ${activeTier}</span>
          <span class="section-tag">${accounts.length} Session Pool</span>
        </div>
      </div>
    </div>

    <!-- Auto-Rotate Smart Switch HUD Bar -->
    <div class="auto-rotate-bar">
      <div class="auto-rotate-left">
        <div class="radar-beacon">
          <div class="radar-pulse-ring"></div>
          <div class="radar-dot"></div>
        </div>
        <div class="auto-text-group">
          <span class="auto-title">${isAutoOn ? 'Auto-Rotate: ACTIVE' : 'Auto-Rotate: PAUSED'}</span>
          <span class="auto-desc">Triggers auto-switch on ≤${autoSwitchStatus.thresholdPercent}% quota</span>
        </div>
      </div>
      <button class="switch-toggle-btn" onclick="toggleAutoSwitch()">
        ${isAutoOn ? 'ON ⚡' : 'OFF'}
      </button>
    </div>

    <!-- Live Telemetry Quota Gauges -->
    <div class="section-title">
      <span>AI Model Quota Telemetry</span>
      <span class="section-tag">Live 5h Rolling</span>
    </div>

    <div class="models-list">
      ${quotaCardsHtml || '<div style="opacity:0.6; text-align:center; padding:12px;">No quota telemetry available</div>'}
    </div>

    <!-- Multi-Account Switchboard Cards -->
    <div class="section-title">
      <span>Sessions Switchboard (${accounts.length})</span>
      <span class="section-tag">1-Click Zero-Reload</span>
    </div>

    <div class="accounts-grid">
      ${accountCardsHtml || '<div style="opacity:0.6; text-align:center; padding:12px;">No accounts loaded</div>'}
    </div>

    <!-- Quick Actions Dock -->
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
      <button class="btn-dock" onclick="refreshAll()" style="grid-column: span 2;">
        <span>🚀 Refresh Telemetry</span>
      </button>
    </div>

  </div>

  <script>
    const vscode = acquireVsCodeApi();

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

    function refreshAll() {
      vscode.postMessage({ command: 'refresh' });
    }

    // Live countdown timer script ticking every 1 second in DOM
    setInterval(() => {
      const cards = document.querySelectorAll('.model-bento-card');
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
