export interface AccountToken {
  accessToken: string;
  refreshToken: string;
  expiryTimestamp: number;
  projectId?: string;
  idToken?: string;
}

export interface ModelQuota {
  modelId: string;
  displayName: string;
  usagePercentage: number;
  remainingQuota: number;
  totalQuota: number;
  resetTimeMs: number;
  resetTimeFormatted: string;
  windowType: 'rolling_5h' | 'weekly';
}

export interface QuotaBucket {
  bucketId: string;
  window: '5h' | 'weekly';
  remainingPercentage: number;
  resetTimeMs: number;
  resetTimeFormatted: string;
  displayName: string;
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  fiveHourBucket?: QuotaBucket;
  weeklyBucket?: QuotaBucket;
}

export interface Account {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isActive: boolean;
  tier?: string; // 'Free' | 'Pro' | 'Ultra'
  token: AccountToken;
  quotas?: ModelQuota[];
  quotaGroups?: QuotaGroup[];
  lastSyncedAt?: number;
}

export interface ConversationStep {
  stepIndex: number;
  type: string;
  source: string;
  timestamp?: string;
  thought?: string;
  contentSnippet?: string;
}

export interface ConversationSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  dateFormatted: string;
  transcriptPath: string;
  stepCount: number;
  model?: string;
  previewText?: string;
  projectName?: string;
  workspacePath?: string;
  tokenEstimate?: number;
}

export interface ContentSearchSnippet {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export interface ContentSearchResult {
  session: ConversationSession;
  snippets: ContentSearchSnippet[];
  matchCount: number;
}

export interface AccountTokenUsage {
  accountEmail: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalTokens: number;
  requestCount: number;
}

export interface ModelTokenUsage {
  model: string;
  totalTokens: number;
  requestCount: number;
}

export interface TokenUsageStats {
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalRequests: number;
  uniqueAccounts: number;
  todayTokens?: number;
  weekTokens?: number;
  byAccount: AccountTokenUsage[];
  byModel: ModelTokenUsage[];
}

