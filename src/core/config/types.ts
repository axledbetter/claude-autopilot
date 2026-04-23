export interface AdapterReference {
  adapter: string;
  options?: Record<string, unknown>;
}

export type AdapterRef = string | AdapterReference;

export type StaticRuleReference = string | { adapter: string; options?: Record<string, unknown> };

export interface GuardrailConfig {
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
  ignore?: Array<string | { rule?: string; path: string }>;
  reviewStrategy?: 'auto' | 'single-pass' | 'file-level' | 'diff' | 'auto-diff';
  chunking?: {
    smallTierMaxTokens?: number;
    partialReviewTokens?: number;
    perFileMaxTokens?: number;
    parallelism?: number;
    rateLimitBackoff?: 'exp' | 'linear' | 'none';
  };
  policy?: {
    /** Severity threshold for exit code 1. Default: 'critical'. Use 'none' to always pass. */
    failOn?: 'critical' | 'warning' | 'note' | 'none';
    /** Only report findings not present in the committed baseline. Default: false. */
    newOnly?: boolean;
    /** Path to baseline file relative to cwd. Default: .guardrail-baseline.json */
    baselinePath?: string;
  };
  cost?: {
    /** Abort review phase if estimated spend exceeds this amount (USD). */
    maxPerRun?: number;
    /** Print token estimate before starting LLM review. Default: false. */
    estimateBeforeRun?: boolean;
    /** Per-model token price overrides (input/output per 1M tokens). */
    pricing?: Record<string, { inputPer1M: number; outputPer1M: number }>;
  };
  cache?: Record<string, unknown>;
  persistence?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
}
