/**
 * Canonical per-model pricing for cost-ledger / cost-estimate / cost-cap features.
 *
 * Computed client-side because the OpenAI Responses API and most provider APIs
 * return token counts but no $-cost field. Without these constants every codex
 * run logged costUSD=0 even though tokens were tracked correctly.
 *
 * Units: USD per 1,000,000 tokens.
 *
 * `cachedInputPer1M` is the price for cached-input tokens (OpenAI's prompt-cache
 * read tier — typically ~1/8 of `inputPer1M`). Set to `null` when the provider
 * doesn't surface a cached tier or we don't have a confirmed published number.
 *
 * Adding a model here does NOT auto-wire it into any adapter — the per-adapter
 * COST_PER_M_INPUT/OUTPUT constants in src/adapters/{council,review-engine}/*.ts
 * remain the actual source of truth for runtime cost computation, and stay
 * env-overridable. This table is the documentation/single-source-of-truth for
 * "what should the defaults be" + drives the cost-ledger config defaults.
 *
 * Keep entries sorted: oldest → newest within each provider, providers
 * alphabetical.
 */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M: number | null;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI ----------------------------------------------------------------
  // gpt-5.3-codex: legacy default (pre-2026-04-23). Kept for back-compat —
  // users may have pinned via CODEX_MODEL env var.
  'gpt-5.3-codex': {
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cachedInputPer1M: null,
  },
  // gpt-5.4: superseded by gpt-5.5 on 2026-04-23. Kept for back-compat.
  'gpt-5.4': {
    inputPer1M: 2.5,
    outputPer1M: 15.0,
    cachedInputPer1M: null,
  },
  // gpt-5.5 (codename Spud, released 2026-04-23): current default for codex
  // adapter + council openai adapter. Better at coding than 5.4 with fewer
  // tokens, but ~2× more expensive per token. Available via standard
  // Responses/Chat Completions API at `gpt-5.5` (no `-codex` suffix).
  // Bugbot MEDIUM PR #93: `cachedInputPer1M` is `null` (NOT 0) until we have
  // a confirmed published number. The interface contract treats `0` as
  // "cached tokens are free" — using it would make consumers silently
  // compute $0 for cached usage. Heuristic is ~1/8 of input (~$0.625/1M)
  // per OpenAI's prompt-cache pattern, but no definitive source yet.
  'gpt-5.5': {
    inputPer1M: 5.0,
    outputPer1M: 30.0,
    cachedInputPer1M: null,
  },
};

/**
 * Look up canonical pricing for a model. Returns `undefined` for unknown
 * models — callers should fall back to env-var defaults rather than throwing,
 * because this table is intentionally non-exhaustive (adapters work with any
 * model the underlying SDK accepts).
 */
export function getModelPricing(model: string): ModelPricing | undefined {
  return MODEL_PRICING[model];
}
