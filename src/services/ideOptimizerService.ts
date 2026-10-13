import * as vscode from 'vscode';

/**
 * Service to protect IDE stability and prevent runaway RAM usage
 * caused by unbounded Language Server indexing and file watcher churning.
 */
export class IdeOptimizerService {
  private static instance: IdeOptimizerService;

  private constructor() {}

  public static initialize(context: vscode.ExtensionContext): IdeOptimizerService {
    if (!IdeOptimizerService.instance) {
      IdeOptimizerService.instance = new IdeOptimizerService();
      IdeOptimizerService.instance.registerCommands(context);
      // Run safe auto-optimization silently in background on activation
      setTimeout(() => {
        IdeOptimizerService.instance.optimizeSettings(true).catch((err) => {
          console.warn('[IdeOptimizer] Background optimization error:', err);
        });
      }, 3000);
    }
    return IdeOptimizerService.instance;
  }

  public static getInstance(): IdeOptimizerService {
    return IdeOptimizerService.instance;
  }

  private registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('antigravityToolkit.optimizeIdePerformance', async () => {
        await this.optimizeSettings(false);
      })
    );
  }

  /**
   * Safely merges recommended performance guards into global settings.
   * NEVER overwrites user-customized keys unless they are missing or causing memory leaks.
   */
  public async optimizeSettings(silent: boolean = true): Promise<boolean> {
    try {
      let appliedChanges = 0;

      // 1. Disable persistentLanguageServer to prevent orphan process stacking
      const antigravityConfig = vscode.workspace.getConfiguration('antigravity');
      const isPersistent = antigravityConfig.get<boolean>('persistentLanguageServer');
      if (isPersistent === true) {
        await antigravityConfig.update('persistentLanguageServer', false, vscode.ConfigurationTarget.Global);
        console.log('[IdeOptimizer] Disabled antigravity.persistentLanguageServer to stop orphan process leaks.');
        appliedChanges++;
      }

      // 2. Safely merge files.watcherExclude
      const filesConfig = vscode.workspace.getConfiguration('files');
      const currentWatcher = { ...(filesConfig.get<Record<string, boolean>>('watcherExclude') || {}) };
      
      const requiredWatcherPatterns: Record<string, boolean> = {
        '**/.git/objects/**': true,
        '**/.git/subtree-cache/**': true,
        '**/node_modules/**': true,
        '**/.next/**': true,
        '**/.turbo/**': true,
        '**/dist/**': true,
        '**/build/**': true,
        '**/target/**': true,
      };

      let watcherModified = false;
      for (const [pattern, val] of Object.entries(requiredWatcherPatterns)) {
        if (currentWatcher[pattern] === undefined) {
          currentWatcher[pattern] = val;
          watcherModified = true;
        }
      }

      if (watcherModified) {
        await filesConfig.update('watcherExclude', currentWatcher, vscode.ConfigurationTarget.Global);
        console.log('[IdeOptimizer] Hardened files.watcherExclude with build & cache directories.');
        appliedChanges++;
      }

      // 3. Safely merge search.exclude
      const searchConfig = vscode.workspace.getConfiguration('search');
      const currentSearch = { ...(searchConfig.get<Record<string, boolean>>('exclude') || {}) };

      const requiredSearchPatterns: Record<string, boolean> = {
        '**/node_modules': true,
        '**/.next': true,
        '**/.turbo': true,
        '**/dist': true,
        '**/build': true,
        '**/target': true,
      };

      let searchModified = false;
      for (const [pattern, val] of Object.entries(requiredSearchPatterns)) {
        if (currentSearch[pattern] === undefined) {
          currentSearch[pattern] = val;
          searchModified = true;
        }
      }

      if (searchModified) {
        await searchConfig.update('exclude', currentSearch, vscode.ConfigurationTarget.Global);
        console.log('[IdeOptimizer] Hardened search.exclude with build & cache directories.');
        appliedChanges++;
      }

      if (!silent) {
        if (appliedChanges > 0) {
          vscode.window.showInformationMessage(
            `🚀 Antigravity IDE Optimized: Applied ${appliedChanges} performance safeguards (File Watchers & Language Server memory).`
          );
        } else {
          vscode.window.showInformationMessage(
            '✅ Antigravity IDE is already fully optimized. No runaway memory patterns detected.'
          );
        }
      }

      return appliedChanges > 0;
    } catch (err) {
      console.error('[IdeOptimizer] Error optimizing IDE settings:', err);
      if (!silent) {
        vscode.window.showErrorMessage(`Failed to apply IDE optimizations: ${String(err)}`);
      }
      return false;
    }
  }
}
