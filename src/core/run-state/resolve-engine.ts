// src/core/run-state/resolve-engine.ts
//
// v6.0.1 — pure precedence resolver for whether the Run State Engine should
// run for a given CLI invocation. Spec: docs/specs/v6-run-state-engine.md
// "Migration path (v5.6 → v6) + precedence matrix" + docs/v6/migration-guide.md
// "How to opt in".
//
// Precedence (highest wins):
//   1. CLI flag         — `--engine` / `--no-engine`
//   2. Env var          — `CLAUDE_AUTOPILOT_ENGINE=on|off|true|false|1|0|yes|no`
//   3. Config           — `engine.enabled: true|false` in guardrail.config.yaml
//   4. Built-in default — v6.0: false; v6.1+: true (per v6.1-default-flip spec)
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

/** v6.0 ships with the engine OFF by default. Flipped to `true` in v6.1
 *  per `docs/specs/v6.1-default-flip.md`. Exported so tests / future
 *  releases can pin a known value. */
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
  const builtIn = builtInDefault ?? ENGINE_DEFAULT_V6_0;

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
    reason: `built-in default (engine ${builtIn ? 'on' : 'off'} in v6.0)${invalidSuffix}`,
    ...(invalidEnvValue !== undefined ? { invalidEnvValue } : {}),
  };
}
