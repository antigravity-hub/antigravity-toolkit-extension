import * as vscode from 'vscode';
import { ModelQuota, Account } from '../types';
import { AccountService } from './accountService';

export class QuotaService {
  private static instance: QuotaService;
  private onDidChangeQuotasEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeQuotas = this.onDidChangeQuotasEmitter.event;

  private constructor() {}

  public static getInstance(): QuotaService {
    if (!QuotaService.instance) {
      QuotaService.instance = new QuotaService();
    }
    return QuotaService.instance;
  }

  /**
   * Generates or extracts active model quota slots with refreshed countdowns.
   */
  public async getActiveQuotas(): Promise<ModelQuota[]> {
    const accountService = AccountService.getInstance();
    const active = accountService.getActiveAccount();
    if (!active) {
      return [];
    }

    return this.getAccountQuotas(active);
  }

  /**
   * Returns models and live countdowns for a given account.
   */
  public getAccountQuotas(account: Account): ModelQuota[] {
    const now = Date.now();
    const fiveHoursFromNow = now + 5 * 60 * 60 * 1000;

    const defaultModels: ModelQuota[] = [
      {
        modelId: 'gemini-3.7-flash',
        displayName: 'Gemini 3.7 Flash',
        usagePercentage: 15,
        remainingQuota: 85,
        totalQuota: 100,
        resetTimeMs: fiveHoursFromNow,
        resetTimeFormatted: this.formatCountdown(5 * 60 * 60 * 1000),
        windowType: 'rolling_5h',
      },
      {
        modelId: 'gemini-3.7-thinking',
        displayName: 'Gemini 3.7 Thinking',
        usagePercentage: 35,
        remainingQuota: 65,
        totalQuota: 100,
        resetTimeMs: fiveHoursFromNow,
        resetTimeFormatted: this.formatCountdown(4 * 60 * 60 * 1000),
        windowType: 'rolling_5h',
      },
      {
        modelId: 'gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        usagePercentage: 60,
        remainingQuota: 40,
        totalQuota: 100,
        resetTimeMs: fiveHoursFromNow,
        resetTimeFormatted: this.formatCountdown(3 * 60 * 60 * 1000),
        windowType: 'rolling_5h',
      },
      {
        modelId: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        usagePercentage: 8,
        remainingQuota: 92,
        totalQuota: 100,
        resetTimeMs: fiveHoursFromNow,
        resetTimeFormatted: this.formatCountdown(5 * 60 * 60 * 1000),
        windowType: 'rolling_5h',
      },
    ];

    const source = account.quotas && account.quotas.length > 0 ? account.quotas : defaultModels;

    // Refresh formatted countdown
    return source.map((q) => {
      const remainingTime = Math.max(0, (q.resetTimeMs || fiveHoursFromNow) - now);
      return {
        ...q,
        remainingQuota: typeof q.remainingQuota === 'number' ? q.remainingQuota : Math.max(0, 100 - q.usagePercentage),
        resetTimeFormatted: this.formatCountdown(remainingTime),
      };
    });
  }

  public formatCountdown(durationMs: number): string {
    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

    if (hours > 0) {
      return `${pad(hours)}h ${pad(minutes)}m`;
    }
    return `${pad(minutes)}m ${pad(seconds)}s`;
  }

  public notifyQuotasUpdated(): void {
    this.onDidChangeQuotasEmitter.fire();
  }
}
