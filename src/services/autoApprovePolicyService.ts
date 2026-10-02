import * as vscode from 'vscode';
import * as path from 'path';
import { AutoApprovePolicyConfig } from '../types';

export class AutoApprovePolicyService {
  private static instance: AutoApprovePolicyService;
  private context: vscode.ExtensionContext;
  private config: AutoApprovePolicyConfig;
  private failureMap: Map<string, { count: number; lastError: string; timestamp: number }> = new Map();

  private readonly STORAGE_KEY = 'antigravity_toolkit_auto_approve_policy';

  private readonly DEFAULT_CONFIG: AutoApprovePolicyConfig = {
    enabled: true,
    autoApproveReads: true,
    autoApproveWorkspaceWrites: true,
    autoApproveSafeCommands: true,
    commandWhitelist: [
      'npm test',
      'npm run build',
      'cargo check',
      'cargo test',
      'git status',
      'git diff',
      'git log',
      'pytest',
      'python -m unittest',
      'tsc --noEmit'
    ],
    zeroTokenWasteCircuitBreaker: true,
    maxConsecutiveFailures: 3,
    maxTokensPerTask: 150000
  };

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    const saved = this.context.globalState.get<AutoApprovePolicyConfig>(this.STORAGE_KEY);
    this.config = saved ? { ...this.DEFAULT_CONFIG, ...saved } : { ...this.DEFAULT_CONFIG };
  }

  public static initialize(context: vscode.ExtensionContext): AutoApprovePolicyService {
    if (!AutoApprovePolicyService.instance) {
      AutoApprovePolicyService.instance = new AutoApprovePolicyService(context);
    }
    return AutoApprovePolicyService.instance;
  }

  public static getInstance(): AutoApprovePolicyService {
    if (!AutoApprovePolicyService.instance) {
      throw new Error('AutoApprovePolicyService has not been initialized');
    }
    return AutoApprovePolicyService.instance;
  }

  public getConfig(): AutoApprovePolicyConfig {
    return { ...this.config };
  }

  public async saveConfig(partial: Partial<AutoApprovePolicyConfig>): Promise<AutoApprovePolicyConfig> {
    this.config = { ...this.config, ...partial };
    await this.context.globalState.update(this.STORAGE_KEY, this.config);
    return this.getConfig();
  }

  public async resetDefaults(): Promise<AutoApprovePolicyConfig> {
    this.config = { ...this.DEFAULT_CONFIG };
    await this.context.globalState.update(this.STORAGE_KEY, this.config);
    return this.getConfig();
  }

  /**
   * Deterministically evaluates whether an agent tool call can be safely auto-approved,
   * needs remote approval from smartphone/IDE, or must be rejected.
   */
  public evaluateToolAction(
    toolName: string,
    args: Record<string, any> = {},
    workspaceRoot?: string
  ): { action: 'approve' | 'ask_user' | 'reject'; reason: string } {
    if (!this.config.enabled) {
      return { action: 'ask_user', reason: 'Auto-approve policies are disabled' };
    }

    const lowerTool = toolName.toLowerCase();

    // 1. Pure Read Tools (Tier 1 Safe Read)
    const readTools = [
      'view_file',
      'read_file',
      'grep_search',
      'read_dir',
      'list_dir',
      'read_url',
      'read_url_content',
      'search_web',
      'list_directory',
      'find_files'
    ];
    if (readTools.some((rt) => lowerTool.includes(rt))) {
      if (this.config.autoApproveReads) {
        return { action: 'approve', reason: 'Safe read-only operation (Tier 1)' };
      }
      return { action: 'ask_user', reason: 'Read operations require approval' };
    }

    // 2. Workspace Mutation Tools (Tier 2 Scoped Mutation)
    const writeTools = ['write_to_file', 'replace_file_content', 'edit_file', 'create_file', 'modify_file'];
    if (writeTools.some((wt) => lowerTool.includes(wt))) {
      const targetPath = args.TargetFile || args.filePath || args.path || args.file;
      if (targetPath && typeof targetPath === 'string') {
        const normalized = path.normalize(targetPath).toLowerCase();
        
        // Never auto-approve sensitive credentials / environment files
        if (
          normalized.endsWith('.env') ||
          normalized.includes('.git/') ||
          normalized.includes('.git\\') ||
          normalized.includes('id_rsa') ||
          normalized.includes('.ssh')
        ) {
          return { action: 'ask_user', reason: 'Target path contains sensitive system or credential files' };
        }

        // Check if inside workspace
        if (workspaceRoot) {
          const normRoot = path.normalize(workspaceRoot).toLowerCase();
          if (!normalized.startsWith(normRoot)) {
            return { action: 'ask_user', reason: 'File mutation is outside active workspace boundary' };
          }
        }

        if (this.config.autoApproveWorkspaceWrites) {
          return { action: 'approve', reason: 'Scoped in-workspace file modification (Tier 2)' };
        }
      }
      return { action: 'ask_user', reason: 'Workspace writes require approval' };
    }

    // 3. Command Execution Tools (Tier 3 Shell Execution)
    const cmdTools = ['run_command', 'execute_command', 'bash', 'terminal', 'shell'];
    if (cmdTools.some((ct) => lowerTool.includes(ct))) {
      const cmdStr = (args.CommandLine || args.command || args.cmd || '').trim().toLowerCase();

      // Check dangerous blacklist
      const dangerousPatterns = ['rm -rf', 'format', 'mkfs', 'del /f /s /q', 'drop database', 'drop table', 'shutdown'];
      if (dangerousPatterns.some((dp) => cmdStr.includes(dp))) {
        return { action: 'reject', reason: 'Command matched high-risk security blacklist' };
      }

      // Check whitelist
      if (this.config.autoApproveSafeCommands) {
        const isWhitelisted = this.config.commandWhitelist.some((wl) => {
          const trimmedWl = wl.trim().toLowerCase();
          return cmdStr.startsWith(trimmedWl) || cmdStr === trimmedWl;
        });

        if (isWhitelisted) {
          return { action: 'approve', reason: 'Command is explicitly whitelisted (Tier 3 Safe)' };
        }
      }

      return { action: 'ask_user', reason: 'Terminal command requires user verification' };
    }

    return { action: 'ask_user', reason: 'Unclassified tool call requires user confirmation' };
  }

  /**
   * Tracks consecutive tool errors to trip the Zero-Token Waste circuit breaker
   */
  public recordFailure(sessionId: string, errorSnippet: string): { circuitBreakerTripped: boolean; consecutiveFailures: number } {
    if (!this.config.zeroTokenWasteCircuitBreaker) {
      return { circuitBreakerTripped: false, consecutiveFailures: 0 };
    }

    const existing = this.failureMap.get(sessionId) || { count: 0, lastError: '', timestamp: Date.now() };
    const newCount = existing.count + 1;
    this.failureMap.set(sessionId, { count: newCount, lastError: errorSnippet, timestamp: Date.now() });

    if (newCount >= this.config.maxConsecutiveFailures) {
      return { circuitBreakerTripped: true, consecutiveFailures: newCount };
    }

    return { circuitBreakerTripped: false, consecutiveFailures: newCount };
  }

  public resetFailures(sessionId: string): void {
    this.failureMap.delete(sessionId);
  }
}
