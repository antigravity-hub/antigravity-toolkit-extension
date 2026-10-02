import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConversationService } from './conversationService';
import { TelegramRemoteService } from './telegramRemoteService';

export class MobileTunnelService {
  private static instance: MobileTunnelService;
  private server?: http.Server;
  private serverPort: number = 8045;
  private tunnelProcess?: child_process.ChildProcess;
  private activeTunnelUrl: string | null = null;
  private isStarting: boolean = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly conversationService: ConversationService,
    private readonly telegramService: TelegramRemoteService
  ) {}

  public static initialize(
    context: vscode.ExtensionContext,
    conversationService: ConversationService,
    telegramService: TelegramRemoteService
  ): MobileTunnelService {
    if (!MobileTunnelService.instance) {
      MobileTunnelService.instance = new MobileTunnelService(context, conversationService, telegramService);
    }
    return MobileTunnelService.instance;
  }

  public static getInstance(): MobileTunnelService {
    return MobileTunnelService.instance;
  }

  public getTunnelUrl(): string | null {
    return this.activeTunnelUrl;
  }

  public isTunnelRunning(): boolean {
    return Boolean(this.activeTunnelUrl && this.tunnelProcess && !this.tunnelProcess.killed);
  }

  public async stopTunnel(): Promise<void> {
    if (this.tunnelProcess) {
      try {
        this.tunnelProcess.kill();
      } catch {}
      this.tunnelProcess = undefined;
    }
    if (process.platform === 'win32') {
      try {
        child_process.execSync('taskkill /F /IM cloudflared.exe', { stdio: 'ignore' });
      } catch {}
    }
    this.activeTunnelUrl = null;
    await this.telegramService.saveConfig({ cloudflareTunnelUrl: '' });
  }

  /**
   * Starts the internal Cyber-Glass Mobile HTTP server.
   */
  public async ensureServerRunning(): Promise<number> {
    if (this.server && this.server.listening) {
      return this.serverPort;
    }

    return new Promise((resolve) => {
      const portsToTry = [8045, 8046, 8047, 8765];
      let portIndex = 0;

      const tryListen = () => {
        const port = portsToTry[portIndex];
        const srv = http.createServer(async (req, res) => {
          await this.handleHttpRequest(req, res);
        });

        srv.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            portIndex++;
            if (portIndex < portsToTry.length) {
              tryListen();
            } else {
              resolve(8045);
            }
          } else {
            resolve(8045);
          }
        });

        srv.listen(port, '127.0.0.1', () => {
          this.server = srv;
          this.serverPort = port;
          resolve(port);
        });
      };

      tryListen();
    });
  }

  /**
   * Finds or downloads the cloudflared executable on the system.
   */
  public async ensureCloudflaredBinary(): Promise<string | null> {
    const home = os.homedir();
    const candidates = [
      path.join(home, '.antigravity-remote', 'cloudflared.exe'),
      path.join(home, '.antigravity_shield', 'bin', 'cloudflared.exe'),
      path.join(home, '.gemini', 'bin', 'cloudflared.exe'),
      'cloudflared.exe',
      'cloudflared'
    ];

    for (const c of candidates) {
      if (path.isAbsolute(c) && fs.existsSync(c)) {
        return c;
      }
    }

    // Auto-download cloudflared if missing
    const targetDir = path.join(home, '.antigravity-remote');
    const targetBin = path.join(targetDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (fs.existsSync(targetBin)) {
      return targetBin;
    }

    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const downloadUrl = process.platform === 'win32'
        ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
        : process.platform === 'darwin'
        ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64'
        : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

      const downloaded = await new Promise<boolean>((resolve) => {
        const fetchWithRedirects = (url: string, hops = 0) => {
          if (hops > 5) return resolve(false);
          https.get(url, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              return fetchWithRedirects(res.headers.location, hops + 1);
            }
            if (res.statusCode !== 200) {
              return resolve(false);
            }
            const outStream = fs.createWriteStream(targetBin);
            res.pipe(outStream);
            outStream.on('finish', () => {
              outStream.close();
              try { fs.chmodSync(targetBin, 0o755); } catch {}
              resolve(true);
            });
            outStream.on('error', () => {
              try { fs.unlinkSync(targetBin); } catch {}
              resolve(false);
            });
          }).on('error', () => resolve(false));
        };
        fetchWithRedirects(downloadUrl);
      });

      if (downloaded && fs.existsSync(targetBin)) {
        return targetBin;
      }
    } catch {
      // Fallback
    }

    return null;
  }

  /**
   * Starts Cloudflare quick tunnel autonomously, resolves trycloudflare.com URL,
   * updates extension state, opens browser, and sends Telegram alert.
   */
  public async startSmartTunnelAndOpenBrowser(): Promise<{ success: boolean; url?: string; magicLink?: string; error?: string }> {
    if (this.isStarting) {
      return { success: false, error: 'Tunnel is already starting...' };
    }
    this.isStarting = true;

    try {
      // 1. Ensure local mobile server is running
      const port = await this.ensureServerRunning();

      // 2. Locate cloudflared binary
      const binPath = await this.ensureCloudflaredBinary();
      if (!binPath || !fs.existsSync(binPath)) {
        this.isStarting = false;
        return { success: false, error: `cloudflared binary could not be found or downloaded.` };
      }

      // If tunnel is already running and alive, reuse existing URL and open browser
      if (this.isTunnelRunning() && this.activeTunnelUrl) {
        const magicLink = this.telegramService.getMagicLink(this.activeTunnelUrl);
        await vscode.env.openExternal(vscode.Uri.parse(magicLink));
        this.isStarting = false;
        return { success: true, url: this.activeTunnelUrl, magicLink };
      }

      // 3. Kill existing stale cloudflared process
      if (this.tunnelProcess) {
        try { this.tunnelProcess.kill(); } catch {}
        this.tunnelProcess = undefined;
      }
      if (process.platform === 'win32') {
        try {
          child_process.execSync('taskkill /F /IM cloudflared.exe', { stdio: 'ignore' });
        } catch {}
      }

      // 4. Launch cloudflared quick tunnel
      const args = ['tunnel', '--url', `http://127.0.0.1:${port}`];
      const proc = child_process.spawn(binPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.tunnelProcess = proc;

      // 5. Capture the trycloudflare.com URL from stdout / stderr
      const tunnelUrl = await new Promise<string | null>((resolve) => {
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }, 12000);

        const checkOutput = (data: Buffer) => {
          const text = data.toString('utf8');
          const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i);
          if (match && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(match[0]);
          }
        };

        proc.stdout?.on('data', checkOutput);
        proc.stderr?.on('data', checkOutput);

        proc.on('exit', () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(null);
          }
        });
      });

      if (!tunnelUrl) {
        this.isStarting = false;
        return { success: false, error: 'Could not capture Cloudflare quick tunnel URL within 12 seconds.' };
      }

      this.activeTunnelUrl = tunnelUrl;

      // 6. Save in Telegram / Remote config
      await this.telegramService.saveConfig({ cloudflareTunnelUrl: tunnelUrl });

      // 7. Generate 1-click magic link with auth token
      const magicLink = this.telegramService.getMagicLink(tunnelUrl);

      // 8. Auto-Open in Browser
      await vscode.env.openExternal(vscode.Uri.parse(magicLink));

      // 9. Auto-Send to Telegram if bot token and chat are configured
      const tgCfg = this.telegramService.getConfig();
      if (tgCfg.botToken && (tgCfg.chatId || tgCfg.forumSupergroupId)) {
        const msg = `🌐 <b>Antigravity Shield Live Mobile View Ready!</b>\n\n` +
          `📱 <b>Tap below to open your live chats and voice control:</b>\n` +
          `<code>${magicLink}</code>`;
        const keyboard = {
          inline_keyboard: [
            [{ text: '🚀 Open Mobile View', url: magicLink }]
          ]
        };
        await this.telegramService.sendTelegramMessage(msg, { reply_markup: keyboard });
      }

      this.isStarting = false;
      return { success: true, url: tunnelUrl, magicLink };
    } catch (err: any) {
      this.isStarting = false;
      return { success: false, error: err?.message || String(err) };
    }
  }

  /**
   * Internal HTTP Request Handler serving Cyber-Glass SPA & Session APIs
   */
  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${this.serverPort}`);
    const pathname = reqUrl.pathname;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. Mobile SPA View (/mobile-view or /)
    if (pathname === '/mobile-view' || pathname === '/') {
      const token = reqUrl.searchParams.get('token') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.renderMobileHtml(token));
      return;
    }

    // 2. API: List active sessions (/api/mobile-sessions)
    if (pathname === '/api/mobile-sessions' && req.method === 'GET') {
      try {
        const sessions = await this.conversationService.getConversations();
        const summaries = sessions.slice(0, 30).map((s) => ({
          id: s.id,
          title: s.title || 'Untitled Session',
          project_name: s.projectName || 'Project',
          updated_at: s.updatedAt || Date.now(),
          step_count: s.stepCount || 1,
          token_estimate: s.tokenEstimate || 0
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summaries));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || String(err) }));
      }
      return;
    }

    // 3. API: Session detail & turns (/api/mobile-sessions/:id)
    if (pathname.startsWith('/api/mobile-sessions/') && req.method === 'GET') {
      const sid = pathname.replace('/api/mobile-sessions/', '').trim();
      try {
        const preview = await this.conversationService.getConversationPreview(sid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(preview));
      } catch (err: any) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found: ' + err?.message }));
      }
      return;
    }

    // 4. API: Mobile chat & voice input (/api/mobile-chat)
    if (pathname === '/api/mobile-chat' && req.method === 'POST') {
      let bodyStr = '';
      req.on('data', (chunk) => (bodyStr += chunk));
      req.on('end', async () => {
        try {
          const body = JSON.parse(bodyStr || '{}');
          if (body.message) {
            const previewText = body.message.slice(0, 80);
            vscode.window.showInformationMessage(`📱 Mobile Input: "${previewText}"`, 'Copy to Clipboard').then((action) => {
              if (action === 'Copy to Clipboard') {
                vscode.env.clipboard.writeText(body.message);
              }
            });
            await vscode.env.clipboard.writeText(body.message);

            // Forward to Telegram topic if configured
            const tgCfg = this.telegramService.getConfig();
            if (tgCfg.botToken && (tgCfg.chatId || tgCfg.forumSupergroupId)) {
              let topicId: number | undefined;
              if (body.sessionId && tgCfg.forumSupergroupId) {
                topicId = await this.telegramService.getOrCreateTopicForSession(body.sessionId, body.title || 'Mobile Chat');
              }
              const noteText = body.audioBase64
                ? `🎙️ <b>Mobile Voice Note Received</b>\n(Session: <code>${body.sessionId || 'Active'}</code>)`
                : `📱 <b>Mobile Input:</b>\n${body.message}`;
              await this.telegramService.sendTelegramMessage(noteText, { threadId: topicId });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err?.message || String(err) }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /**
   * Renders the complete, responsive Cyber-Glass Mobile SPA HTML
   */
  private renderMobileHtml(token: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Antigravity Shield • Live Mobile View</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
    :root {
      --bg: #070b14;
      --card-bg: rgba(15, 23, 42, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --seafoam: #2dd4bf;
      --seafoam-light: #5eead4;
      --seafoam-glow: rgba(45, 212, 191, 0.25);
      --accent-cyan: #38bdf8;
      --accent-orange: #f97316;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      height: 100dvh;
      overflow: hidden;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: rgba(11, 18, 33, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--card-border);
      flex-shrink: 0;
      z-index: 10;
    }
    .header-brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand-icon {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(45, 212, 191, 0.2), rgba(56, 189, 248, 0.2));
      border: 1px solid var(--seafoam);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }
    .brand-title {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
    }
    .brand-sub {
      font-size: 9.5px;
      color: var(--seafoam-light);
      font-weight: 600;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 10px;
      color: #34d399;
      font-weight: 600;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 6px #10b981;
    }
    .session-bar {
      padding: 8px 14px;
      background: rgba(15, 23, 42, 0.5);
      border-bottom: 1px solid var(--card-border);
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .session-select {
      flex: 1;
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid var(--card-border);
      color: #fff;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 11px;
      outline: none;
    }
    .timeline {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      -webkit-overflow-scrolling: touch;
    }
    .turn {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-width: 90%;
      animation: fadeIn 0.2s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .turn-user {
      align-self: flex-end;
    }
    .turn-model {
      align-self: flex-start;
      max-width: 94%;
    }
    .turn-bubble {
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
      unicode-bidi: plaintext;
    }
    .turn-user .turn-bubble {
      background: linear-gradient(135deg, rgba(45, 212, 191, 0.25) 0%, rgba(15, 118, 110, 0.35) 100%);
      border: 1px solid rgba(45, 212, 191, 0.4);
      color: #f1f5f9;
      border-bottom-right-radius: 3px;
    }
    .turn-model .turn-bubble {
      background: rgba(20, 28, 44, 0.8);
      border: 1px solid var(--card-border);
      color: #e2e8f0;
      border-bottom-left-radius: 3px;
    }
    .turn-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 9.5px;
      color: var(--text-muted);
      margin-bottom: 2px;
    }
    .turn-user .turn-meta {
      justify-content: flex-end;
    }
    .thought-card {
      background: rgba(30, 41, 59, 0.5);
      border: 1px dashed rgba(45, 212, 191, 0.3);
      border-radius: 8px;
      margin-bottom: 6px;
      overflow: hidden;
    }
    .thought-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 10px;
      font-size: 10.5px;
      color: var(--seafoam-light);
      cursor: pointer;
      user-select: none;
    }
    .thought-body {
      display: none;
      padding: 8px 10px;
      font-size: 11px;
      color: #cbd5e1;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      background: rgba(15, 23, 42, 0.6);
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .tools-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 4px;
    }
    .tool-tag {
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: #38bdf8;
      font-size: 9.5px;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
    }
    .dock {
      padding: 10px 14px;
      background: rgba(11, 18, 33, 0.95);
      backdrop-filter: blur(12px);
      border-top: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }
    .dock-row {
      display: flex;
      align-items: flex-end;
      gap: 8px;
    }
    .dock-textarea {
      flex: 1;
      background: rgba(30, 41, 59, 0.85);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      color: #fff;
      padding: 10px 12px;
      font-size: 13px;
      font-family: inherit;
      resize: none;
      max-height: 120px;
      min-height: 42px;
      outline: none;
    }
    .dock-btn {
      width: 42px;
      height: 42px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      font-size: 16px;
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.15s ease;
    }
    .btn-send {
      background: linear-gradient(135deg, #2dd4bf, #0f766e);
      color: #042f2e;
    }
    .btn-mic {
      background: rgba(249, 115, 22, 0.15);
      border: 1px solid rgba(249, 115, 22, 0.3);
      color: #f97316;
    }
    .btn-mic.recording {
      background: #ef4444;
      color: #fff;
      animation: pulse 1s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.08); }
      100% { transform: scale(1); }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-brand">
      <div class="brand-icon">🛡️</div>
      <div>
        <div class="brand-title">Antigravity Shield</div>
        <div class="brand-sub">Live Mobile View</div>
      </div>
    </div>
    <div class="status-badge">
      <span class="status-dot"></span>
      <span id="conn-status">Live</span>
    </div>
  </header>

  <div class="session-bar">
    <select id="session-select" class="session-select" onchange="onSessionChange(this.value)">
      <option value="">Loading sessions...</option>
    </select>
  </div>

  <main class="timeline" id="timeline">
    <div style="text-align: center; padding: 40px 10px; color: var(--text-muted); font-size: 12px;">
      Loading conversation turns...
    </div>
  </main>

  <footer class="dock">
    <div class="dock-row">
      <button type="button" class="dock-btn btn-mic" id="btn-mic" onclick="toggleVoiceRecording()" title="Record Voice">
        🎙️
      </button>
      <textarea
        id="prompt-input"
        class="dock-textarea"
        rows="1"
        placeholder="Type a message or instruction..."
        dir="auto"
        onkeydown="handleKey(event)"
      ></textarea>
      <button type="button" class="dock-btn btn-send" onclick="sendPrompt()" title="Send">
        ➤
      </button>
    </div>
  </footer>

  <script>
    var AUTH_TOKEN = "${token}";
    var activeSessionId = "";
    var isRecording = false;
    var mediaRecorder = null;
    var audioChunks = [];

    if (AUTH_TOKEN) {
      localStorage.setItem('ag_mobile_token', AUTH_TOKEN);
    } else {
      AUTH_TOKEN = localStorage.getItem('ag_mobile_token') || '';
    }

    function apiFetch(url, options) {
      options = options || {};
      options.headers = options.headers || {};
      if (AUTH_TOKEN) {
        options.headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
      }
      return fetch(url, options);
    }

    function loadSessions() {
      apiFetch('/api/mobile-sessions')
        .then(function(res) { return res.json(); })
        .then(function(sessions) {
          var sel = document.getElementById('session-select');
          if (!sessions || sessions.length === 0) {
            sel.innerHTML = '<option value="">No Active Sessions</option>';
            return;
          }
          var html = '';
          for (var i = 0; i < sessions.length; i++) {
            var s = sessions[i];
            html += '<option value="' + s.id + '"' + (i === 0 && !activeSessionId ? ' selected' : '') + '>' +
              '📁 ' + (s.project_name || 'Project') + ': ' + (s.title || s.id.slice(0, 8)) +
              '</option>';
          }
          sel.innerHTML = html;
          if (!activeSessionId && sessions[0]) {
            activeSessionId = sessions[0].id;
            loadTimeline(activeSessionId);
          }
        })
        .catch(function(err) {
          console.error('Failed to load sessions:', err);
        });
    }

    function onSessionChange(val) {
      if (val && val !== activeSessionId) {
        activeSessionId = val;
        loadTimeline(val);
      }
    }

    function loadTimeline(sessionId) {
      if (!sessionId) return;
      apiFetch('/api/mobile-sessions/' + sessionId)
        .then(function(res) { return res.json(); })
        .then(function(detail) {
          renderTurns(detail.turns || []);
        })
        .catch(function(err) {
          console.error('Failed to load timeline:', err);
        });
    }

    function renderTurns(turns) {
      var container = document.getElementById('timeline');
      if (!turns || turns.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px 10px; color: var(--text-muted); font-size: 12px;">No messages in this session yet.</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < turns.length; i++) {
        var t = turns[i];
        var isUser = t.role === 'user';
        html += '<div class="turn ' + (isUser ? 'turn-user' : 'turn-model') + '">';
        html += '<div class="turn-meta">';
        html += '<span>' + (isUser ? '👤 User' : '🤖 Assistant') + '</span>';
        if (t.timestamp) {
          var timeStr = t.timestamp.split('T')[1] ? t.timestamp.split('T')[1].slice(0, 5) : '';
          if (timeStr) html += '<span>• ' + timeStr + '</span>';
        }
        html += '</div>';

        if (t.thought) {
          html += '<div class="thought-card">';
          html += '<div class="thought-header" onclick="toggleThought(this)">';
          html += '<span>🧠 Thought Process</span><span>›</span>';
          html += '</div>';
          html += '<div class="thought-body">' + escapeHtml(t.thought) + '</div>';
          html += '</div>';
        }

        if (t.toolCalls && t.toolCalls.length > 0) {
          html += '<div class="tools-wrap">';
          for (var j = 0; j < t.toolCalls.length; j++) {
            html += '<span class="tool-tag">⚙ ' + escapeHtml(t.toolCalls[j]) + '</span>';
          }
          html += '</div>';
        }

        html += '<div class="turn-bubble">' + escapeHtml(t.content) + '</div>';
        html += '</div>';
      }
      container.innerHTML = html;
      container.scrollTop = container.scrollHeight;
    }

    function toggleThought(headerEl) {
      var body = headerEl.nextElementSibling;
      var chevron = headerEl.children[1];
      if (body.style.display === 'block') {
        body.style.display = 'none';
        if (chevron) chevron.innerText = '›';
      } else {
        body.style.display = 'block';
        if (chevron) chevron.innerText = '⌄';
      }
    }

    function escapeHtml(text) {
      return (text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function handleKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    }

    function sendPrompt() {
      var input = document.getElementById('prompt-input');
      var text = input ? input.value.trim() : '';
      if (!text || !activeSessionId) return;

      input.value = '';
      apiFetch('/api/mobile-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeSessionId,
          message: text
        })
      }).then(function() {
        setTimeout(function() { loadTimeline(activeSessionId); }, 800);
      });
    }

    function toggleVoiceRecording() {
      var btn = document.getElementById('btn-mic');
      if (!isRecording) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          alert('Microphone access is not supported in this browser.');
          return;
        }
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then(function(stream) {
            isRecording = true;
            btn.classList.add('recording');
            audioChunks = [];
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = function(e) {
              if (e.data.size > 0) audioChunks.push(e.data);
            };
            mediaRecorder.onstop = function() {
              var audioBlob = new Blob(audioChunks, { type: 'audio/ogg' });
              var reader = new FileReader();
              reader.readAsDataURL(audioBlob);
              reader.onloadend = function() {
                var base64data = reader.result.split(',')[1];
                apiFetch('/api/mobile-chat', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    sessionId: activeSessionId,
                    message: '[Voice Note]',
                    audioBase64: base64data
                  })
                }).then(function() {
                  setTimeout(function() { loadTimeline(activeSessionId); }, 800);
                });
              };
            };
            mediaRecorder.start();
          })
          .catch(function(err) {
            alert('Could not access microphone: ' + err.message);
          });
      } else {
        isRecording = false;
        btn.classList.remove('recording');
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      }
    }

    setInterval(function() {
      if (activeSessionId) {
        loadTimeline(activeSessionId);
      }
    }, 2500);

    loadSessions();
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    if (this.tunnelProcess) {
      try { this.tunnelProcess.kill(); } catch {}
      this.tunnelProcess = undefined;
    }
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = undefined;
    }
  }
}
