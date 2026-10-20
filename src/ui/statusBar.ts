import * as vscode from 'vscode';
import { AccountService } from '../services/accountService';
import { QuotaService } from '../services/quotaService';
import { AutoSwitchService } from '../services/autoSwitchService';
import { NetworkWatchdogService } from '../services/networkWatchdogService';
import { ShieldBridge } from '../bridge/shieldBridge';

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private argonStatusBarItem: vscode.StatusBarItem;

  constructor(
    private accountService: AccountService,
    private quotaService: QuotaService,
    private autoSwitchService: AutoSwitchService,
    private networkWatchdog: NetworkWatchdogService
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'antigravityToolkit.openQuotaDashboard';

    this.argonStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99
    );
    this.argonStatusBarItem.command = 'antigravityToolkit.configureArgonBrain';

    this.accountService.onDidChangeAccounts(() => this.update());
    this.quotaService.onDidChangeQuotas(() => this.update());
    this.autoSwitchService.onDidChangeStatus(() => this.update());
    this.networkWatchdog.onDidChangeStatus(() => this.update());

    this.update();
  }

  public async update(): Promise<void> {
    await this.updateArgonStatus();
    const config = vscode.workspace.getConfiguration('antigravityToolkit');
    const enabled = config.get<boolean>('showStatusBarBadge', true);
    if (!enabled) {
      this.statusBarItem.hide();
      return;
    }

    const netStatus = this.networkWatchdog.getStatus();
    if (netStatus === 'offline') {
      this.statusBarItem.text = `$(cloud-offline) AI: Waiting for Network...`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      const tip = new vscode.MarkdownString();
      tip.isTrusted = true;
      tip.supportThemeIcons = true;
      tip.appendMarkdown(`### $(cloud-offline) Network Disconnected\n\n`);
      tip.appendMarkdown(`VPN or Internet connection appears offline.\n\n`);
      tip.appendMarkdown(`**Auto-Heal:** Active. The toolkit will automatically revive the Language Server once connection is re-established.\n\n`);
      tip.appendMarkdown(`---\n\n`);
      tip.appendMarkdown(`[$(debug-restart) Force Restart Language Server](command:antigravityToolkit.restartLanguageServer)`);
      this.statusBarItem.tooltip = tip;
      this.statusBarItem.show();
      return;
    }

    if (netStatus === 'reconnecting') {
      this.statusBarItem.text = `$(sync~spin) AI: Auto-Healing...`;
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    this.statusBarItem.backgroundColor = undefined;

    const active = this.accountService.getActiveAccount();
    if (!active) {
      this.statusBarItem.text = '$(shield) Antigravity: No Account';
      this.statusBarItem.tooltip = 'Click to connect or sync an Antigravity account';
      this.statusBarItem.show();
      return;
    }

    const health = Math.round(this.accountService.getAccountHealth(active));
    const isAutoOn = this.autoSwitchService.isEnabled();
    const autoIcon = isAutoOn ? '$(zap)' : '$(circle-slash)';

    const icon =
      health > 50
        ? '$(pass-filled)'
        : health > 20
        ? '$(warning)'
        : '$(error)';

    const shortName = active.email.split('@')[0];
    this.statusBarItem.text = `${autoIcon} ${shortName} [${health}%]`;

    // Rich Markdown Tooltip
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;
    tooltip.appendMarkdown(`### $(shield) Antigravity Toolkit 2.0\n\n`);
    tooltip.appendMarkdown(`**Active Session:** \`${active.email}\`\n\n`);
    tooltip.appendMarkdown(`**Plan Tier:** \`${active.tier || 'Google AI Pro'}\`\n\n`);
    tooltip.appendMarkdown(`**Aggregate Quota:** **${health}%** ${icon}\n\n`);
    tooltip.appendMarkdown(`**Network & Server:** 🟢 Connected & Healthy\n\n`);
    tooltip.appendMarkdown(`**Auto-Rotate:** ${isAutoOn ? '🟢 **Active** (Switches on ≤2%)' : '⚪ **Paused**'}\n\n`);
    tooltip.appendMarkdown(`---\n\n`);
    tooltip.appendMarkdown(`[$(dashboard) Open HUD Dashboard](command:antigravityToolkit.openQuotaDashboard) • `);
    tooltip.appendMarkdown(`[$(arrow-swap) Quick Switch](command:antigravityToolkit.switchAccount) • `);
    tooltip.appendMarkdown(`[$(debug-restart) Restart AI Server](command:antigravityToolkit.restartLanguageServer) • `);
    tooltip.appendMarkdown(`[$(sync) Sync Shield](command:antigravityToolkit.syncWithShield)\n`);

    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.show();
  }

  public async updateArgonStatus(): Promise<void> {
    try {
      const bridge = ShieldBridge.getInstance();
      const status = await bridge.getArgonOverride();
      if (!status || !status.enabled) {
        this.argonStatusBarItem.text = '$(shield) Argon: Off';
        this.argonStatusBarItem.backgroundColor = undefined;
        const tip = new vscode.MarkdownString();
        tip.isTrusted = true;
        tip.supportThemeIcons = true;
        tip.appendMarkdown(`### $(shield) Gemini 4 Argon Brain Override\n\n`);
        tip.appendMarkdown(`**Status:** ⚪ Inactive (IDE uses native Flash models)\n\n`);
        tip.appendMarkdown(`Click to route IDE Flash chat requests directly into **Gemini 4 Argon** with deep reasoning.\n\n`);
        tip.appendMarkdown(`---\n\n`);
        tip.appendMarkdown(`[$(sparkles) Configure & Enable Argon Brain](command:antigravityToolkit.configureArgonBrain)`);
        this.argonStatusBarItem.tooltip = tip;
      } else {
        const tierUpper = (status.tier || 'high').toUpperCase();
        this.argonStatusBarItem.text = `$(sparkles) Argon: ${tierUpper}`;
        this.argonStatusBarItem.backgroundColor = undefined;
        const tip = new vscode.MarkdownString();
        tip.isTrusted = true;
        tip.supportThemeIcons = true;
        tip.appendMarkdown(`### $(sparkles) Gemini 4 Argon Brain Active\n\n`);
        tip.appendMarkdown(`**Target Model:** \`${status.target_model || 'gemini-4-argon-' + status.tier}\`\n\n`);
        tip.appendMarkdown(`**Reasoning Tier:** **${tierUpper}**\n\n`);
        tip.appendMarkdown(`**Mode:** 🟢 All IDE chat traffic targeting Gemini 3.8 Flash is hijacked and routed to Gemini 4 Argon with deep thinking.\n\n`);
        tip.appendMarkdown(`---\n\n`);
        tip.appendMarkdown(`[$(gear) Switch Tier / Disable](command:antigravityToolkit.configureArgonBrain)`);
        this.argonStatusBarItem.tooltip = tip;
      }
      this.argonStatusBarItem.show();
    } catch {
      this.argonStatusBarItem.hide();
    }
  }

  public dispose(): void {
    this.statusBarItem.dispose();
    this.argonStatusBarItem.dispose();
  }
}
