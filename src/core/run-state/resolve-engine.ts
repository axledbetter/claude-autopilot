// src/core/run-state/resolve-engine.ts
//
// v7.0 — engine-off path retired. The function is preserved for source
// compatibility with callers that pass `cliEngine` / `envValue` /
// `configEnabled`, but it now returns `enabled: true` unconditionally.
//
// What changed in v7.0 vs v6.x:
//   - `ENGINE_DEFAULT_V6_0` and `ENGINE_DEFAULT_V6_1` exports REMOVED.
//     Direct importers must replace with literal `true` (see
//     docs/v7/breaking-changes.md).
//   - The deprecation warning helpers (`emitEngineOffDeprecationWarning`
//     / `shouldWarnEngineOffDeprecation` / `ENGINE_OFF_DEPRECATION_MESSAGE`)
//     are RETAINED as no-op stubs so call sites don't have to change in
//     the same PR — they always return false / never fire.
//   - `parseEngineEnvValue()` is RETAINED for back-compat with any
//     out-of-tree callers; `resolveEngineEnabled()` ignores the env
//     value entirely (the engine-off env path is gone).
//
// Why keep the stub function shape: the CLI dispatcher passes
// `cliEngine` / `envEngine` / config to `runPhaseWithLifecycle`, which
// in turn calls `resolveEngineEnabled()`. Those parameters become
// effective no-ops in v7.0 — the values are observed (so a future PR
// can re-enable the path or surface a deprecation event) but never
// override the always-on result.

/** What the resolver decided plus the rationale. The `source` field tells
 *  callers which precedence layer won so they can surface it in diagnostics
 *  (`runs show`, `--json` envelopes, etc.). */
export interface ResolveEngineResult {
  /** Final decision — whether the engine runs for this invocation.
   *  v7.0+: always `true`. */
  enabled: boolean;
  /** Which precedence layer produced the decision. v7.0+: always
   *  `'default'` (engine is unconditionally on). */
  source: 'cli' | 'env' | 'config' | 'default';
  /** Human-readable explanation. */
  reason: string;
  /** When the env value was malformed in pre-v7 callers, this carried
   *  the raw string so the caller could route a `run.warning`. v7.0+
   *  ignores env values entirely; field is left undefined. */
  invalidEnvValue?: string;
}

export interface ResolveEngineOptions {
  /** Pre-v7 CLI flag override. v7.0+ ignores this — the engine is
   *  always on. */
  cliEngine?: boolean;
  /** Pre-v7 env value. v7.0+ ignores this. */
  envValue?: string;
  /** Pre-v7 config value. v7.0+ ignores this. */
  configEnabled?: boolean;
  /** Pre-v7 built-in default override. v7.0+ ignores this. */
  builtInDefault?: boolean;
}

/** Parse a stringly-typed env value into a tri-state boolean.
 *  Retained for back-compat with any out-of-tree callers; the v7
 *  resolver does not consult env values. */
export function parseEngineEnvValue(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return undefined;
  switch (normalized) {
    case 'on':
    case 'true':
    case '1':
    case 'yes':
      return true;
    case 'off':
    case 'false':
    case '0':
    case 'no':
      return false;
    default:
      return undefined;
  }
}

/** v7.0+ — engine is always on. Pure function; ignores all inputs.
 *  Source compatible with v6.x call sites. */
export function resolveEngineEnabled(_opts: ResolveEngineOptions = {}): ResolveEngineResult {
  return {
    enabled: true,
    source: 'default',
    reason: 'v7.0+ — engine always on (engine-off path removed)',
  };
}

// ---------------------------------------------------------------------------
// v6.1 deprecation helpers — retained as no-op stubs for source compat.
// v7.0 removed the engine-off path entirely; no warning ever fires.
// ---------------------------------------------------------------------------

/** v6.1-era stable deprecation banner. v7.0+ never emits this string —
 *  the path is gone. Kept exported so out-of-tree consumers that imported
 *  it still type-check. */
export const ENGINE_OFF_DEPRECATION_MESSAGE =
  '[deprecation] --no-engine / engine.enabled: false were removed in v7.0. Migration: drop the flag/env/config.';

export type EngineDeprecationWarn = (message: string) => void;

/** v7.0+ no-op. Always returns false. */
export function shouldWarnEngineOffDeprecation(
  _resolved: Pick<ResolveEngineResult, 'enabled' | 'source'>,
): boolean {
  return false;
}

/** v7.0+ no-op. Always returns false. */
export function emitEngineOffDeprecationWarning(
  _resolved: Pick<ResolveEngineResult, 'enabled' | 'source'>,
  _warn: EngineDeprecationWarn = () => {},
): boolean {
  return false;
}
