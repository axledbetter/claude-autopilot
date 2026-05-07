// src/core/run-state/resolve-engine.ts
//
// v6.0.1 — pure precedence resolver for whether the Run State Engine should
// run for a given CLI invocation. Spec: docs/specs/v6-run-state-engine.md
// "Migration path (v5.6 → v6) + precedence matrix" + docs/v6/migration-guide.md
// "How to opt in".
//
// v6.1 update — built-in default flipped from `false` → `true` per
// docs/specs/v6.1-default-flip.md. Users who opt out explicitly via
// `--no-engine`, `CLAUDE_AUTOPILOT_ENGINE=off|false|0|no`, or
// `engine.enabled: false` in `guardrail.config.yaml` keep the legacy
// (engine-off) behavior, but they now receive a deprecation warning —
// the escape hatch goes away in v7. See `emitEngineOffDeprecationWarning`
// below.
//
// Precedence (highest wins):
//   1. CLI flag         — `--engine` / `--no-engine`
//   2. Env var          — `CLAUDE_AUTOPILOT_ENGINE=on|off|true|false|1|0|yes|no`
//   3. Config           — `engine.enabled: true|false` in guardrail.config.yaml
//   4. Built-in default — v6.1+: true (was false in v6.0)
//
// This module is intentionally pure and side-effect-free: it never reads from
// the environment or the config file directly. Callers (the CLI dispatcher)
// gather the inputs and pass them in — that keeps the function trivially
// testable and lets the dispatcher own all I/O.
//
// Invalid env values do NOT throw. The contract from the spec / migration
// guide is "treat as unset and emit a run.warning so observers can attribute
// the fallthrough." This module returns metadata — the resolver caller
// (cli/index.ts) is responsible for emitting the warning event.

/** What the resolver decided plus the rationale. The `source` field tells
 *  callers which precedence layer won so they can surface it in diagnostics
 *  (`runs show`, `--json` envelopes, etc.). */
export interface ResolveEngineResult {
  /** Final decision — whether the engine runs for this invocation. */
  enabled: boolean;
  /** Which precedence layer produced the decision. */
  source: 'cli' | 'env' | 'config' | 'default';
  /** Human-readable explanation, suitable for run.warning details / verbose
   *  CLI output / debug logs. */
  reason: string;
  /** When `source === 'env'` and the env value was malformed, this carries the
   *  raw string so the caller can route a `run.warning` describing the
   *  fallthrough. Absent on the happy path. */
  invalidEnvValue?: string;
}

export interface ResolveEngineOptions {
  /** True if `--engine` was passed; false if `--no-engine`; undefined if
   *  neither flag was present. The CLI parser is responsible for rejecting
   *  the case where BOTH flags are passed before this function is called. */
  cliEngine?: boolean;
  /** Raw value of `process.env.CLAUDE_AUTOPILOT_ENGINE`. Undefined if the
   *  variable is unset. Empty string is treated as unset (matches Node's
   *  convention). Case-insensitive parsing of the string value. */
  envValue?: string;
  /** Value of `engine.enabled` from guardrail.config.yaml, or undefined if
   *  the config file is missing / does not declare the key. */
  configEnabled?: boolean;
  /** Built-in default. v6.0: false. Tests pin this explicitly to exercise
   *  the v6.1-flip behavior without needing to bump the constant globally. */
  builtInDefault?: boolean;
}

/** v6.1+ ships with the engine ON by default — flipped from the v6.0
 *  default (`false`) per `docs/specs/v6.1-default-flip.md`. Exported so
 *  tests / future releases can pin a known value. */
export const ENGINE_DEFAULT_V6_1 = true as const;
/** Historical v6.0 default. Preserved verbatim — its semantic meaning
 *  ("the v6.0 default was off") doesn't change just because the active
 *  default flipped. Out-of-tree consumers that pinned this constant get
 *  the value the name promises. Use `ENGINE_DEFAULT_V6_1` for the active
 *  default. Removed in v7.
 *  @deprecated Use `ENGINE_DEFAULT_V6_1` or omit `builtInDefault` to inherit
 *  the active default. */
export const ENGINE_DEFAULT_V6_0 = false as const;

/** Parse a stringly-typed env value into a tri-state boolean.
 *  Accepts (case-insensitive): on, off, true, false, 1, 0, yes, no.
 *  Returns undefined for any other input INCLUDING empty / whitespace-only
 *  strings — that signals the caller to fall through to the next precedence
 *  layer. */
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

/** Resolve whether the Run State Engine should run for this invocation.
 *  Pure function — does not touch process.env, fs, or anything I/O. */
export function resolveEngineEnabled(opts: ResolveEngineOptions = {}): ResolveEngineResult {
  const { cliEngine, envValue, configEnabled, builtInDefault } = opts;
  const builtIn = builtInDefault ?? ENGINE_DEFAULT_V6_1;

  // Layer 1 — CLI flag wins outright.
  if (cliEngine === true) {
    return { enabled: true, source: 'cli', reason: '--engine flag' };
  }
  if (cliEngine === false) {
    return { enabled: false, source: 'cli', reason: '--no-engine flag' };
  }

  // Layer 2 — env var.
  if (envValue !== undefined && envValue.trim() !== '') {
    const parsed = parseEngineEnvValue(envValue);
    if (parsed !== undefined) {
      return {
        enabled: parsed,
        source: 'env',
        reason: `CLAUDE_AUTOPILOT_ENGINE=${envValue}`,
      };
    }
    // Invalid value — fall through, but record the raw value so the caller
    // can emit a run.warning. Continue to config / default below.
    // We bind it here so it survives the recursion-style fallthrough.
    return resolveWithFallthrough({
      configEnabled,
      builtIn,
      invalidEnvValue: envValue,
    });
  }

  return resolveWithFallthrough({ configEnabled, builtIn });
}

interface FallthroughOpts {
  configEnabled?: boolean;
  builtIn: boolean;
  invalidEnvValue?: string;
}

/** Layers 3 + 4 — config, then built-in default. Factored out so the env
 *  invalid-value path can reach the same logic without recursing into
 *  resolveEngineEnabled (which would re-evaluate the env var and loop). */
function resolveWithFallthrough(opts: FallthroughOpts): ResolveEngineResult {
  const { configEnabled, builtIn, invalidEnvValue } = opts;
  const invalidSuffix = invalidEnvValue !== undefined
    ? `; invalid CLAUDE_AUTOPILOT_ENGINE=${JSON.stringify(invalidEnvValue)} ignored`
    : '';

  if (configEnabled === true) {
    return {
      enabled: true,
      source: 'config',
      reason: `engine.enabled: true in guardrail.config.yaml${invalidSuffix}`,
      ...(invalidEnvValue !== undefined ? { invalidEnvValue } : {}),
    };
  }
  if (configEnabled === false) {
    return {
      enabled: false,
      source: 'config',
      reason: `engine.enabled: false in guardrail.config.yaml${invalidSuffix}`,
      ...(invalidEnvValue !== undefined ? { invalidEnvValue } : {}),
    };
  }

  return {
    enabled: builtIn,
    source: 'default',
    reason: `built-in default (engine ${builtIn ? 'on' : 'off'} in v6.1+)${invalidSuffix}`,
    ...(invalidEnvValue !== undefined ? { invalidEnvValue } : {}),
  };
}

// ---------------------------------------------------------------------------
// v6.1 deprecation warning for explicit engine-off
// ---------------------------------------------------------------------------

/** Stable copy emitted on stderr when a user explicitly opts out of the
 *  engine via `--no-engine`, `CLAUDE_AUTOPILOT_ENGINE=off`, or
 *  `engine.enabled: false`. v7 removes the escape hatch entirely.
 *
 *  Exported for tests + downstream consumers (e.g. CI parsers) that want to
 *  match against the exact string. Kept on a single line so terminals don't
 *  wrap mid-message. */
export const ENGINE_OFF_DEPRECATION_MESSAGE =
  '[deprecation] --no-engine / engine.enabled: false will be removed in v7. Migrate to engine-on (default).';

/** Optional callback shape for the deprecation warner. Tests pass a capture
 *  function; production callers omit it and get the default `process.stderr`
 *  writer. Kept narrow (single-arg) so a `jest.fn` or a `(msg) => lines.push(msg)`
 *  array sink is trivially droppable. */
export type EngineDeprecationWarn = (message: string) => void;

/** Decide whether v6.1's `--no-engine` deprecation warning applies for a
 *  given resolver result. Returns `true` ONLY when the user explicitly
 *  opted out (via CLI flag, env var, or config) — never on the v6.1 default
 *  (which is `enabled: true`, so it can't trigger here anyway) and never
 *  when the engine is actually on. Pure: takes the resolver result, returns
 *  a boolean.
 *
 *  Why this is a separate predicate (not collapsed into the warner): the
 *  CLI dispatcher wants to ALSO emit a typed `run.warning` event into a
 *  ledger when the engine ends up on but the resolver came from a layer
 *  that's about to be removed — except today, on v6.1, the only path that
 *  warns IS the "engine off, explicit opt-out" path. So the predicate
 *  collapses cleanly to that single condition. v7 removes both. */
export function shouldWarnEngineOffDeprecation(
  resolved: Pick<ResolveEngineResult, 'enabled' | 'source'>,
): boolean {
  if (resolved.enabled) return false;
  return (
    resolved.source === 'cli' ||
    resolved.source === 'env' ||
    resolved.source === 'config'
  );
}

/** Emit the v6.1 `--no-engine` deprecation warning to stderr (or the
 *  supplied `warn` callback) when the resolver result indicates the user
 *  explicitly opted out of the engine. No-op when:
 *    - the engine is on (no opt-out happened);
 *    - the source is `'default'` (v6.1's flipped default = on, so a default
 *      result with `enabled: false` is impossible without a custom
 *      `builtInDefault` override — and even that path doesn't warn since
 *      it's not a user-driven opt-out).
 *
 *  Pure-ish: side-effect is captured behind the optional `warn` callback so
 *  tests can assert on the message without spawning a subprocess. The
 *  default warner writes to `process.stderr` with a trailing newline.
 *
 *  Returns `true` when the warning fired, `false` when it was a no-op. The
 *  return value is purely informational — callers can use it to decide
 *  whether to also append a `run.warning` event into a run ledger (only
 *  meaningful on the engine-on path; the v6.1 deprecation only fires on
 *  engine-off, where there's no run dir to write into). */
export function emitEngineOffDeprecationWarning(
  resolved: Pick<ResolveEngineResult, 'enabled' | 'source'>,
  warn: EngineDeprecationWarn = (msg) => {
    process.stderr.write(`${msg}\n`);
  },
): boolean {
  if (!shouldWarnEngineOffDeprecation(resolved)) return false;
  warn(ENGINE_OFF_DEPRECATION_MESSAGE);
  return true;
}
