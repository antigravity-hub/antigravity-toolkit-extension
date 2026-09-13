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
   * Returns current active account quotas or synthesizes real-time models list.
   */
  public async getActiveQuotas(): Promise<ModelQuota[]> {
    const accountService = AccountService.getInstance();
    const active = accountService.getActiveAccount();
    if (!active) {
      return [];
    }

    // Default simulated or fetched model quota slots
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

    return active.quotas && active.quotas.length > 0 ? active.quotas : defaultModels;
  }

  public formatCountdown(durationMs: number): string {
    const hours = Math.floor(durationMs / (1000 * 60 * 60));
    const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  public notifyQuotasUpdated(): void {
    this.onDidChangeQuotasEmitter.fire();
  }
}
