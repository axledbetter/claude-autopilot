import type { SchemaAlignmentConfig } from '../schema-alignment/types.ts';
import type { DeployConfig } from '../../adapters/deploy/types.ts';

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
  pipeline?: {
    /**
     * When true, run the LLM review phase even if the static-rules phase reports `fail`
     * (i.e. finds a critical). Default: true. Set to false to skip only the review
     * phase on static-fail — the tests phase still runs regardless.
     *
     * Users that explicitly configure a review engine typically expect it to run — the
     * bugs the LLM is best at (IDOR, TOCTOU, CORS, off-by-one, rate limits) often sit
     * in the same commit as something a static rule already flagged. This flag only
     * gates the review phase, mirroring `runReviewOnTestFail`.
     */
    runReviewOnStaticFail?: boolean;
    /**
     * When true, run the LLM review phase even if the tests phase reports `fail`.
     * Default: false — failing tests usually indicate broken code, not code to review.
     * This flag only gates the review phase; the tests phase itself always runs.
     */
    runReviewOnTestFail?: boolean;
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
  /**
   * Deploy phase configuration. Optional — when absent, the deploy phase is a
   * no-op. See `src/adapters/deploy/types.ts` for the full DeployConfig shape.
   */
  deploy?: DeployConfig;
  cache?: Record<string, unknown>;
  persistence?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  /**
   * Run State Engine (v6) configuration. v6.0 ships the engine OFF by default
   * to preserve v5.x behavior; v6.1+ flips the default to ON per
   * `docs/specs/v6.1-default-flip.md`. The `engine.enabled` knob is the
   * lowest-priority opt-in — env (`CLAUDE_AUTOPILOT_ENGINE`) and CLI flags
   * (`--engine` / `--no-engine`) override it. See
   * `src/core/run-state/resolve-engine.ts` for the precedence resolver.
   */
  engine?: {
    enabled?: boolean;
  };
  council?: {
    models: Array<{ adapter: string; model: string; label: string }>;
    synthesizer: { adapter: string; model: string; label: string };
    timeout_ms?: number;
    min_successful_responses?: number;
    parallel_input_max_tokens?: number;
    synthesis_input_max_tokens?: number;
  };
}
