import type { SchemaAlignmentConfig } from '../schema-alignment/types.ts';

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
  brand?: {
    /** Path to tailwind.config.{ts,js} — auto-extracts theme.colors as canonical palette */
    colorsFrom?: string;
    /** Explicit canonical color values (hex/rgb/hsl). Merged with colorsFrom. */
    colors?: string[];
    /** Canonical font family names */
    fonts?: string[];
    /** Path to design system component library (informational, for future LLM review) */
    componentLibrary?: string | { tokens?: string; guide?: string };
  };
  'schema-alignment'?: SchemaAlignmentConfig;
  cache?: Record<string, unknown>;
  persistence?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  council?: {
    models: Array<{ adapter: string; model: string; label: string }>;
    synthesizer: { adapter: string; model: string; label: string };
    timeout_ms?: number;
    min_successful_responses?: number;
    parallel_input_max_tokens?: number;
    synthesis_input_max_tokens?: number;
  };
}
