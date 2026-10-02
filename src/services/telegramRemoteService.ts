import * as vscode from 'vscode';
import * as https from 'https';
import { TelegramRemoteConfig } from '../types';

export class TelegramRemoteService {
  private static instance: TelegramRemoteService;
  private context: vscode.ExtensionContext;
  private config: TelegramRemoteConfig;
  private pollingTimer: NodeJS.Timeout | undefined;
  private lastUpdateId = 0;
  private isPolling = false;

  private readonly STORAGE_KEY = 'antigravity_toolkit_telegram_config';

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    const saved = this.context.globalState.get<TelegramRemoteConfig>(this.STORAGE_KEY);
    this.config = saved || {
      enabled: false,
      botToken: '',
      chatId: '',
      notifyOnCompletion: true,
      notifyOnNeedInput: true,
      notifyOnError: true,
      status: 'disconnected'
    };

    if (this.config.enabled && this.config.botToken) {
      this.startPollingLoop();
    }
  }

  public static initialize(context: vscode.ExtensionContext): TelegramRemoteService {
    if (!TelegramRemoteService.instance) {
      TelegramRemoteService.instance = new TelegramRemoteService(context);
    }
    return TelegramRemoteService.instance;
  }

  public static getInstance(): TelegramRemoteService {
    if (!TelegramRemoteService.instance) {
      throw new Error('TelegramRemoteService has not been initialized');
    }
    return TelegramRemoteService.instance;
  }

  public getConfig(): TelegramRemoteConfig {
    return { ...this.config };
  }

  public async saveConfig(partial: Partial<TelegramRemoteConfig>): Promise<TelegramRemoteConfig> {
    this.config = { ...this.config, ...partial };
    
    // Auto-update status
    if (!this.config.botToken || !this.config.chatId) {
      this.config.status = 'disconnected';
    } else if (this.config.enabled) {
      this.config.status = 'connected';
    }

    await this.context.globalState.update(this.STORAGE_KEY, this.config);

    if (this.config.enabled && this.config.botToken) {
      this.startPollingLoop();
    } else {
      this.stopPollingLoop();
    }

    return this.getConfig();
  }

  public async generatePairingCode(): Promise<{ code: string; expiresAt: number }> {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    this.config.pairingCode = code;
    this.config.pairingCodeExpires = expiresAt;
    this.config.status = 'pairing';
    await this.context.globalState.update(this.STORAGE_KEY, this.config);

    return { code, expiresAt };
  }

  public async sendTelegramMessage(
    text: string,
    options?: { parse_mode?: string; reply_markup?: any }
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.config.botToken || !this.config.chatId) {
      return { success: false, error: 'Telegram Bot Token or Chat ID is not configured' };
    }

    return new Promise((resolve) => {
      const payload = JSON.stringify({
        chat_id: this.config.chatId,
        text,
        parse_mode: options?.parse_mode || 'HTML',
        reply_markup: options?.reply_markup
      });

      const reqOptions: https.RequestOptions = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${encodeURIComponent(this.config.botToken)}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      };

      const req = https.request(reqOptions, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });

        res.on('end', () => {
          try {
            const data = JSON.parse(responseBody);
            if (data.ok) {
              resolve({ success: true });
            } else {
              resolve({ success: false, error: data.description || 'Telegram API returned error' });
            }
          } catch (e: any) {
            resolve({ success: false, error: `Invalid response: ${e.message}` });
          }
        });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Request timed out' });
      });

      req.write(payload);
      req.end();
    });
  }

  public async sendTestNotification(): Promise<{ success: boolean; message: string }> {
    if (!this.config.botToken) {
      return { success: false, message: 'Please provide a valid Telegram Bot Token from @BotFather' };
    }
    if (!this.config.chatId) {
      return { success: false, message: 'Please provide your Telegram Chat ID (or use pairing code)' };
    }

    const testMsg = `🛡️ <b>Antigravity Shield Alert</b>\n\n` +
      `✅ <b>Telegram Remote Connected Successfully!</b>\n` +
      `🖥️ <b>Host:</b> Antigravity IDE\n` +
      `⏰ <b>Timestamp:</b> ${new Date().toLocaleTimeString()}\n\n` +
      `<i>You will now receive prompt completions and tool approval notifications here.</i>`;

    const res = await this.sendTelegramMessage(testMsg);
    if (res.success) {
      this.config.status = 'connected';
      this.config.lastPingTimestamp = Date.now();
      await this.context.globalState.update(this.STORAGE_KEY, this.config);
      return { success: true, message: 'Test notification sent successfully!' };
    } else {
      return { success: false, message: res.error || 'Failed to send Telegram message' };
    }
  }

  public async notifyPromptCompleted(title: string, details?: { turns?: number; tokens?: number }): Promise<void> {
    if (!this.config.enabled || !this.config.notifyOnCompletion) return;

    const tokenText = details?.tokens ? `\n🔥 <b>Tokens:</b> ~${details.tokens.toLocaleString()}` : '';
    const turnText = details?.turns ? `\n🔄 <b>Turns:</b> ${details.turns}` : '';
    const msg = `✅ <b>Session Prompt Completed</b>\n\n` +
      `📝 <b>Task:</b> <code>${this.escapeHtml(title)}</code>` +
      tokenText + turnText +
      `\n⏰ <b>Time:</b> ${new Date().toLocaleTimeString()}`;

    await this.sendTelegramMessage(msg);
  }

  public async notifyNeedInput(toolName: string, promptPreview: string): Promise<void> {
    if (!this.config.enabled || !this.config.notifyOnNeedInput) return;

    const msg = `⚠️ <b>Agent Needs Approval / Input</b>\n\n` +
      `🔧 <b>Tool:</b> <code>${this.escapeHtml(toolName)}</code>\n` +
      `💬 <b>Summary:</b> <i>${this.escapeHtml(promptPreview.slice(0, 300))}</i>\n\n` +
      `<i>Check your IDE terminal or click below to respond:</i>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `approve_${Date.now()}` },
          { text: '❌ Reject', callback_data: `reject_${Date.now()}` }
        ]
      ]
    };

    await this.sendTelegramMessage(msg, { reply_markup: keyboard });
  }

  public async notifyError(errorMessage: string): Promise<void> {
    if (!this.config.enabled || !this.config.notifyOnError) return;

    const msg = `🛑 <b>Antigravity Shield Alert</b>\n\n` +
      `🚨 <b>Error / Circuit Breaker Tripped:</b>\n` +
      `<code>${this.escapeHtml(errorMessage.slice(0, 400))}</code>\n\n` +
      `⏰ ${new Date().toLocaleTimeString()}`;

    await this.sendTelegramMessage(msg);
  }

  private startPollingLoop(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    this.scheduleNextPoll(1000);
  }

  private stopPollingLoop(): void {
    this.isPolling = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  private scheduleNextPoll(delayMs = 5000): void {
    if (!this.isPolling) return;
    this.pollingTimer = setTimeout(() => {
      this.pollUpdates().finally(() => {
        if (this.isPolling) {
          this.scheduleNextPoll(5000);
        }
      });
    }, delayMs);
  }

  private async pollUpdates(): Promise<void> {
    if (!this.config.botToken) return;

    try {
      const urlPath = `/bot${encodeURIComponent(this.config.botToken)}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=3`;
      const data = await this.httpGetJson(urlPath);
      if (data && data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          if (update.update_id) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          }
          await this.handleIncomingUpdate(update);
        }
      }
    } catch {
      // Ignore network hiccup during polling
    }
  }

  private async handleIncomingUpdate(update: any): Promise<void> {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    // Check pairing command
    if (text.startsWith('/pair')) {
      const parts = text.split(' ');
      const providedCode = parts[1]?.trim();
      if (
        this.config.pairingCode &&
        this.config.pairingCodeExpires &&
        Date.now() < this.config.pairingCodeExpires &&
        providedCode === this.config.pairingCode
      ) {
        this.config.chatId = chatId;
        this.config.enabled = true;
        this.config.status = 'connected';
        this.config.pairingCode = undefined;
        this.config.pairingCodeExpires = undefined;
        await this.context.globalState.update(this.STORAGE_KEY, this.config);

        await this.sendTelegramMessage(
          `🎉 <b>Antigravity Shield Paired!</b>\n\nYour smartphone is now securely linked to Antigravity IDE. You will receive real-time notifications here.`
        );
        return;
      } else {
        await this.sendTelegramMessage(
          `❌ <b>Invalid or expired pairing code.</b> Please generate a new code in the Antigravity Shield Remote tab.`
        );
        return;
      }
    }

    // Only respond to verified chat_id
    if (this.config.chatId && chatId !== this.config.chatId) {
      return;
    }

    if (text === '/status') {
      const statusMsg = `🛡️ <b>Antigravity Shield Status</b>\n\n` +
        `🟢 <b>Daemon:</b> Online\n` +
        `📱 <b>Remote Link:</b> Active\n` +
        `⏰ <b>Server Time:</b> ${new Date().toLocaleTimeString()}\n\n` +
        `<i>Use /stop to cancel the active task or wait for prompt completion alerts.</i>`;
      await this.sendTelegramMessage(statusMsg);
    } else if (text === '/stop') {
      vscode.commands.executeCommand('workbench.action.chat.cancel');
      await this.sendTelegramMessage(`🛑 <b>Stop signal dispatched to IDE!</b> Active agent generation aborted.`);
    } else if (text === '/help') {
      const helpMsg = `📖 <b>Available Commands:</b>\n\n` +
        `/status - Check IDE & Agent live status\n` +
        `/stop - Abort running coding agent\n` +
        `/pair &lt;code&gt; - Pair this phone with Antigravity Shield`;
      await this.sendTelegramMessage(helpMsg);
    }
  }

  private httpGetJson(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        {
          hostname: 'api.telegram.org',
          port: 443,
          path,
          timeout: 5000
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
    });
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  public dispose(): void {
    this.stopPollingLoop();
  }
}
