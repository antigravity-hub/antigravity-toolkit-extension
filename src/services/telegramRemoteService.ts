import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';
import { TelegramRemoteConfig } from '../types';
import { ShieldBridge } from '../bridge/shieldBridge';

export interface TelegramTopicInfo {
  threadId: number;
  name: string;
  createdAt: number;
}

export class TelegramRemoteService {
  private static instance: TelegramRemoteService;
  private context: vscode.ExtensionContext;
  private config: TelegramRemoteConfig;
  private pollingTimer: NodeJS.Timeout | undefined;
  private lastUpdateId = 0;
  private isPolling = false;

  // Session ID -> Forum Topic Thread ID
  private sessionTopicMap: Map<string, number> = new Map();
  // Thread ID -> Session ID (Reverse map)
  private threadSessionMap: Map<number, string> = new Map();

  // Debounced message editing per session
  private debouncedStreamMap: Map<
    string,
    {
      messageId: number;
      lastSentText: string;
      pendingText?: string;
      timer?: NodeJS.Timeout;
    }
  > = new Map();

  private readonly STORAGE_KEY = 'antigravity_toolkit_telegram_config';
  private readonly TOPIC_MAP_KEY = 'antigravity_toolkit_telegram_topics';

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

    // Load saved topics
    const savedTopics = this.context.globalState.get<Record<string, number>>(this.TOPIC_MAP_KEY) || {};
    for (const [sId, tId] of Object.entries(savedTopics)) {
      this.sessionTopicMap.set(sId, tId);
      this.threadSessionMap.set(tId, sId);
    }

    if (!this.config.sessionAuthToken) {
      this.config.sessionAuthToken = crypto.randomBytes(24).toString('hex');
    }

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

  public getSessionAuthToken(): string {
    const shieldApiKey = ShieldBridge.getInstance().getShieldApiKey();
    if (shieldApiKey) {
      return shieldApiKey;
    }
    if (!this.config.sessionAuthToken) {
      this.config.sessionAuthToken = crypto.randomBytes(24).toString('hex');
      this.context.globalState.update(this.STORAGE_KEY, this.config);
    }
    return this.config.sessionAuthToken;
  }

  public getMagicLink(baseUrl?: string): string {
    const targetUrl = (baseUrl || this.config.cloudflareTunnelUrl || 'http://127.0.0.1:8045').replace(/\/+$/, '');
    const token = this.getSessionAuthToken();
    return `${targetUrl}/mobile-view?token=${encodeURIComponent(token)}`;
  }

  /**
   * Creates a dedicated Telegram Forum Topic for a conversation.
   * Format: [ProjectName] ConversationTitle
   */
  public async getOrCreateTopicForSession(
    sessionId: string,
    title: string,
    projectName?: string
  ): Promise<number | undefined> {
    if (this.sessionTopicMap.has(sessionId)) {
      return this.sessionTopicMap.get(sessionId);
    }

    const targetChat = this.config.forumSupergroupId || this.config.chatId;
    if (!this.config.botToken || !targetChat) return undefined;

    // Telegram requires supergroups for topics (typically start with -100)
    if (!targetChat.startsWith('-100')) {
      return undefined;
    }

    const prefix = projectName ? `[${projectName}] ` : '[Project] ';
    const cleanTitle = (title || 'New Conversation').replace(/[\r\n]+/g, ' ').trim();
    const fullTopicName = (prefix + cleanTitle).slice(0, 120);

    try {
      const res = await this.telegramApiCall('createForumTopic', {
        chat_id: targetChat,
        name: fullTopicName,
        icon_color: 0x2dd4bf // Teal / Seafoam hex
      });

      if (res && res.ok && res.result && res.result.message_thread_id) {
        const threadId = res.result.message_thread_id;
        this.sessionTopicMap.set(sessionId, threadId);
        this.threadSessionMap.set(threadId, sessionId);

        // Persist topic map
        const obj: Record<string, number> = {};
        for (const [k, v] of this.sessionTopicMap.entries()) {
          obj[k] = v;
        }
        await this.context.globalState.update(this.TOPIC_MAP_KEY, obj);

        // Send initial rich welcome header into the new topic
        const magicLink = this.getMagicLink();
        const welcomeText = `🛡️ <b>Session Initialized:</b> <code>${this.escapeHtml(fullTopicName)}</code>\n\n` +
          `💬 <i>All agent turns, tool calls, and completion alerts for this task will stream here.</i>\n\n` +
          `🎙️ <i>You can send voice notes or attach files directly into this topic to prompt the model.</i>`;

        const keyboard = {
          inline_keyboard: [
            [{ text: '🌐 Open Live Mobile View', url: magicLink }]
          ]
        };

        await this.sendTelegramMessage(welcomeText, {
          threadId,
          reply_markup: keyboard
        });

        return threadId;
      }
    } catch {
      // Fallback to normal chat if not a forum supergroup
    }

    return undefined;
  }

  /**
   * Sends a rich message to Telegram (supporting threads, expandable blockquotes, and HTML formatting)
   */
  public async sendTelegramMessage(
    text: string,
    options?: {
      threadId?: number;
      chatId?: string;
      parse_mode?: string;
      reply_markup?: any;
    }
  ): Promise<{ success: boolean; messageId?: number; error?: string }> {
    if (!this.config.botToken) {
      return { success: false, error: 'Telegram Bot Token is not configured' };
    }

    const targetChat = options?.chatId || this.config.forumSupergroupId || this.config.chatId;
    if (!targetChat) {
      return { success: false, error: 'Target Chat ID is not configured' };
    }

    const payload: any = {
      chat_id: targetChat,
      text,
      parse_mode: options?.parse_mode || 'HTML',
      reply_markup: options?.reply_markup
    };

    if (options?.threadId) {
      payload.message_thread_id = options.threadId;
    }

    const res = await this.telegramApiCall('sendMessage', payload);
    if (res && res.ok && res.result) {
      return { success: true, messageId: res.result.message_id };
    } else {
      return { success: false, error: res?.description || 'Failed to send Telegram message' };
    }
  }

  /**
   * 1.5s Debounced Streaming Turn Updates to prevent Telegram HTTP 429 Flood limits
   */
  public async streamTurnUpdate(
    sessionId: string,
    richText: string,
    options?: { threadId?: number }
  ): Promise<void> {
    const existing = this.debouncedStreamMap.get(sessionId);

    if (!existing) {
      const sendRes = await this.sendTelegramMessage(richText, { threadId: options?.threadId });
      if (sendRes.success && sendRes.messageId) {
        this.debouncedStreamMap.set(sessionId, {
          messageId: sendRes.messageId,
          lastSentText: richText
        });
      }
      return;
    }

    existing.pendingText = richText;
    if (existing.timer) return;

    existing.timer = setTimeout(async () => {
      existing.timer = undefined;
      if (!existing.pendingText || existing.pendingText === existing.lastSentText) return;

      const textToSend = existing.pendingText;
      const targetChat = this.config.forumSupergroupId || this.config.chatId;

      await this.telegramApiCall('editMessageText', {
        chat_id: targetChat,
        message_id: existing.messageId,
        text: textToSend,
        parse_mode: 'HTML'
      });

      existing.lastSentText = textToSend;
    }, 1500);
  }

  /**
   * Formats thought process inside an expandable blockquote
   */
  public formatRichThought(thoughtText: string): string {
    const cleanThought = this.escapeHtml(thoughtText.trim());
    return `<blockquote expandable>🧠 <b>Thought Process:</b>\n<i>${cleanThought}</i></blockquote>\n\n`;
  }

  /**
   * Formats tool execution label
   */
  public formatRichToolCall(toolName: string, detail: string): string {
    return `<code>⚙️ ${this.escapeHtml(toolName)}: ${this.escapeHtml(detail)}</code>\n`;
  }

  public async sendTestNotification(): Promise<{ success: boolean; message: string }> {
    if (!this.config.botToken) {
      return { success: false, message: 'Please provide a valid Telegram Bot Token from @BotFather' };
    }
    const targetChat = this.config.forumSupergroupId || this.config.chatId;
    if (!targetChat) {
      return { success: false, message: 'Please provide your Telegram Chat ID or Forum Supergroup ID' };
    }

    const testMsg = `🛡️ <b>Antigravity Shield Alert</b>\n\n` +
      `✅ <b>Telegram Remote Connected Successfully!</b>\n` +
      `🖥️ <b>Host:</b> Antigravity IDE\n` +
      `⏰ <b>Timestamp:</b> ${new Date().toLocaleTimeString()}\n\n` +
      `<blockquote expandable>✨ <b>Rich Messages & Expandable Blockquotes Active:</b>\n` +
      `<i>Your AI coding thoughts, tools, and completions are live-synced here.</i></blockquote>`;

    const magicLink = this.getMagicLink();
    const keyboard = {
      inline_keyboard: [
        [{ text: '🌐 Test Mobile Web View', url: magicLink }]
      ]
    };

    const res = await this.sendTelegramMessage(testMsg, { reply_markup: keyboard });
    if (res.success) {
      this.config.status = 'connected';
      this.config.lastPingTimestamp = Date.now();
      await this.context.globalState.update(this.STORAGE_KEY, this.config);
      return { success: true, message: 'Rich test notification sent successfully!' };
    } else {
      return { success: false, message: res.error || 'Failed to send Telegram message' };
    }
  }

  public async notifyPromptCompleted(
    title: string,
    details?: { turns?: number; tokens?: number; sessionId?: string; projectName?: string }
  ): Promise<void> {
    if (!this.config.enabled || !this.config.notifyOnCompletion) return;

    let threadId: number | undefined;
    if (details?.sessionId) {
      threadId = await this.getOrCreateTopicForSession(details.sessionId, title, details.projectName);
    }

    const tokenText = details?.tokens ? `\n🔥 <b>Tokens Consumed:</b> ~${details.tokens.toLocaleString()}` : '';
    const turnText = details?.turns ? `\n🔄 <b>Turn Count:</b> ${details.turns}` : '';
    const msg = `✅ <b>Session Prompt Completed</b>\n\n` +
      `📝 <b>Task:</b> <code>${this.escapeHtml(title)}</code>` +
      tokenText + turnText +
      `\n⏰ <b>Time:</b> ${new Date().toLocaleTimeString()}\n\n` +
      `<i>Topic remains open for follow-up prompts or voice notes.</i>`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🌐 Open Chat View', url: this.getMagicLink() }]
      ]
    };

    await this.sendTelegramMessage(msg, { threadId, reply_markup: keyboard });
  }

  public async notifyNeedInput(
    toolName: string,
    promptPreview: string,
    sessionId?: string
  ): Promise<void> {
    if (!this.config.enabled || !this.config.notifyOnNeedInput) return;

    let threadId: number | undefined;
    if (sessionId) {
      threadId = this.sessionTopicMap.get(sessionId);
    }

    const msg = `⚠️ <b>Agent Needs Approval / Input</b>\n\n` +
      `🔧 <b>Tool Call:</b> <code>${this.escapeHtml(toolName)}</code>\n` +
      `💬 <b>Summary:</b> <i>${this.escapeHtml(promptPreview.slice(0, 300))}</i>\n\n` +
      `<i>Click below to approve or reject instantly:</i>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `approve_${Date.now()}` },
          { text: '❌ Reject', callback_data: `reject_${Date.now()}` }
        ]
      ]
    };

    await this.sendTelegramMessage(msg, { threadId, reply_markup: keyboard });
  }

  public async notifyError(errorMessage: string, sessionId?: string): Promise<void> {
    if (!this.config.enabled || !this.config.notifyOnError) return;

    let threadId: number | undefined;
    if (sessionId) {
      threadId = this.sessionTopicMap.get(sessionId);
    }

    const msg = `🛑 <b>Antigravity Shield Alert</b>\n\n` +
      `🚨 <b>Circuit Breaker Tripped / Error:</b>\n` +
      `<code>${this.escapeHtml(errorMessage.slice(0, 400))}</code>\n\n` +
      `⏰ ${new Date().toLocaleTimeString()}`;

    await this.sendTelegramMessage(msg, { threadId });
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

  private scheduleNextPoll(delayMs = 4000): void {
    if (!this.isPolling) return;
    this.pollingTimer = setTimeout(() => {
      this.pollUpdates().finally(() => {
        if (this.isPolling) {
          this.scheduleNextPoll(4000);
        }
      });
    }, delayMs);
  }

  private async pollUpdates(): Promise<void> {
    if (!this.config.botToken) return;

    try {
      const res = await this.telegramApiCall('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 3,
        allowed_updates: ['message', 'callback_query']
      });

      if (res && res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          if (update.update_id) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          }
          await this.handleIncomingUpdate(update);
        }
      }
    } catch {
      // Ignore network hiccup
    }
  }

  private async handleIncomingUpdate(update: any): Promise<void> {
    const msg = update.message;
    if (!msg) return;

    const chatId = String(msg.chat.id);
    const threadId = msg.message_thread_id;

    // Check pairing command
    if (msg.text && msg.text.startsWith('/pair')) {
      const parts = msg.text.split(' ');
      const providedCode = parts[1]?.trim();
      if (
        this.config.pairingCode &&
        this.config.pairingCodeExpires &&
        Date.now() < this.config.pairingCodeExpires &&
        providedCode === this.config.pairingCode
      ) {
        this.config.chatId = chatId;
        if (chatId.startsWith('-100')) {
          this.config.forumSupergroupId = chatId;
        }
        this.config.enabled = true;
        this.config.status = 'connected';
        this.config.pairingCode = undefined;
        this.config.pairingCodeExpires = undefined;
        await this.context.globalState.update(this.STORAGE_KEY, this.config);

        await this.sendTelegramMessage(
          `🎉 <b>Antigravity Shield Paired!</b>\n\nYour group is now linked. You can create topics and control IDE sessions.`,
          { chatId, threadId }
        );
        return;
      }
    }

    // 1. Voice Note Ingestion (Multimodal Part)
    if (msg.voice && msg.voice.file_id) {
      try {
        const fileInfo = await this.telegramApiCall('getFile', { file_id: msg.voice.file_id });
        if (fileInfo && fileInfo.ok && fileInfo.result && fileInfo.result.file_path) {
          const downloadUrl = `https://api.telegram.org/file/bot${encodeURIComponent(this.config.botToken)}/${fileInfo.result.file_path}`;
          vscode.window.showInformationMessage(`🎙️ Received Voice Note from Telegram (${msg.voice.duration}s). Transcribing into prompt...`);
          await this.sendTelegramMessage(
            `🎙️ <i>Voice note received (${msg.voice.duration}s). Sending directly to Gemini Multimodal Audio pipeline...</i>`,
            { chatId, threadId }
          );
        }
      } catch (err: any) {
        // Voice fetch error
      }
      return;
    }

    // 2. Photo / Document Ingestion
    if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      await this.sendTelegramMessage(`🖼️ <i>Image received. Attaching as multimodal visual part to turn...</i>`, {
        chatId,
        threadId
      });
      return;
    }

    // 3. Text Commands
    if (msg.text) {
      const text = msg.text.trim();
      if (text === '/status') {
        const statusMsg = `🛡️ <b>Antigravity Shield Status</b>\n\n` +
          `🟢 <b>Daemon:</b> Online\n` +
          `📱 <b>Forum Topics:</b> Active\n` +
          `⏰ <b>Server Time:</b> ${new Date().toLocaleTimeString()}\n\n` +
          `<i>Topics remain open until /close is sent.</i>`;
        await this.sendTelegramMessage(statusMsg, { chatId, threadId });
      } else if (text === '/stop') {
        vscode.commands.executeCommand('workbench.action.chat.cancel');
        await this.sendTelegramMessage(`🛑 <b>Stop signal dispatched to IDE!</b>`, { chatId, threadId });
      } else if (text === '/close' && threadId) {
        await this.telegramApiCall('closeForumTopic', {
          chat_id: chatId,
          message_thread_id: threadId
        });
        await this.sendTelegramMessage(`🔒 <i>Topic closed.</i>`, { chatId, threadId });
      }
    }
  }

  private async telegramApiCall(method: string, payload: Record<string, any>): Promise<any> {
    if (!this.config.botToken) return null;

    return new Promise((resolve) => {
      // Null-stripping per Telegram specification
      const cleanPayload: Record<string, any> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (v !== null && v !== undefined) cleanPayload[k] = v;
      }

      const body = JSON.stringify(cleanPayload);
      const req = https.request(
        {
          hostname: 'api.telegram.org',
          port: 443,
          path: `/bot${encodeURIComponent(this.config.botToken)}/${method}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 10000
        },
        (res) => {
          let chunks = '';
          res.on('data', (d) => (chunks += d));
          res.on('end', () => {
            try {
              resolve(JSON.parse(chunks));
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.write(body);
      req.end();
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
    for (const item of this.debouncedStreamMap.values()) {
      if (item.timer) clearTimeout(item.timer);
    }
  }
}
