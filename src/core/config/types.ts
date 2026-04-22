export interface AdapterReference {
  adapter: string;
  options?: Record<string, unknown>;
}

export type AdapterRef = string | AdapterReference;

export type StaticRuleReference = string | { adapter: string; options?: Record<string, unknown> };

export interface AutopilotConfig {
  configVersion: 1;
  preset?: string;
  reviewEngine?: AdapterRef;
  vcsHost?: AdapterRef;
  migrationRunner?: AdapterRef;
  reviewBot?: AdapterRef;
  adapterAllowlist?: string[];
  protectedPaths?: string[];
  staticRules?: StaticRuleReference[];
  staticRulesParallel?: boolean;
  stack?: string;
  testCommand?: string | null;
  thresholds?: {
    bugbotAutoFix?: number;
    bugbotProposePatch?: number;
    maxValidateRetries?: number;
    maxCodexRetries?: number;
    maxBugbotRounds?: number;
  };
  reviewStrategy?: 'auto' | 'single-pass' | 'file-level' | 'diff';
  chunking?: {
    smallTierMaxTokens?: number;
    partialReviewTokens?: number;
    perFileMaxTokens?: number;
    parallelism?: number;
    rateLimitBackoff?: 'exp' | 'linear' | 'none';
  };
  cost?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  persistence?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
}
