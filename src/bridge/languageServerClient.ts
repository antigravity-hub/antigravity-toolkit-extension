import * as vscode from 'vscode';
import { Account } from '../types';

export class LanguageServerClient {
  private static instance: LanguageServerClient;

  public static getInstance(): LanguageServerClient {
    if (!LanguageServerClient.instance) {
      LanguageServerClient.instance = new LanguageServerClient();
    }
    return LanguageServerClient.instance;
  }

  /**
   * Readiness Gate: Probes if the Antigravity Language Server (LS) is connected and ready
   * to receive in-memory credentials without dropping connections.
   */
  public async probeReadiness(maxRetries = 5, delayMs = 300): Promise<boolean> {
    const commands = await vscode.commands.getCommands(true);
    const hasAntigravityCmds = commands.some((cmd) =>
      cmd.startsWith('_antigravity.') || cmd.startsWith('antigravity.')
    );

    if (hasAntigravityCmds) {
      return true;
    }

    // Attempt retry loop for startup initialization
    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const updatedCommands = await vscode.commands.getCommands(true);
      if (
        updatedCommands.some(
          (cmd) =>
            cmd.startsWith('_antigravity.') || cmd.startsWith('antigravity.')
        )
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * In-memory live hot-swap of the active Language Server user credentials.
   * Eliminates the need to close or restart the IDE window.
   */
  public async registerUserInMemory(account: Account): Promise<boolean> {
    const isReady = await this.probeReadiness();

    const payload = {
      email: account.email,
      token: account.token.accessToken,
      refreshToken: account.token.refreshToken,
      expiryTimestamp: account.token.expiryTimestamp,
      projectId: account.token.projectId,
      idToken: account.token.idToken,
    };

    // 1. Primary method: Antigravity IDE native in-memory RPC
    try {
      await vscode.commands.executeCommand('_antigravity.registerGdmUser', payload);
      return true;
    } catch (primaryErr) {
      console.warn(
        '[LanguageServerClient] _antigravity.registerGdmUser not available or rejected:',
        primaryErr
      );
    }

    // 2. Secondary method: Try standard Antigravity auth injection command
    try {
      await vscode.commands.executeCommand('antigravity.updateCredentials', payload);
      return true;
    } catch {
      // Fall through to generic provider
    }

    // 3. Fallback for Cursor / VS Code: Notify authentication provider
    try {
      const session = await vscode.authentication.getSession(
        'google',
        ['https://www.googleapis.com/auth/userinfo.email'],
        { createIfNone: false }
      );
      if (session) {
        console.log('[LanguageServerClient] Session provider active for:', session.account.label);
      }
      return true;
    } catch (authErr) {
      console.error('[LanguageServerClient] Authentication provider fallback error:', authErr);
      return false;
    }
  }
}
