// src/cli/engine-flag-deprecation.ts
//
// v7.0 — exported deprecation constants for the engine-flag removal.
// Pulled out of src/cli/index.ts so tests can import them without
// triggering the dispatcher's top-level switch (which exits the
// process on module load).

/** Banner emitted to stderr (once per process) when `--engine` is
 *  passed in v7.0+. The flag is preserved as a no-op shim; the engine
 *  is unconditionally on. Codex pass-3 NOTE #2. */
export const ENGINE_FLAG_DEPRECATION_MESSAGE =
  '[deprecation] --engine is a no-op in v7.0+ (engine is always on). Drop the flag from your scripts.';

/** Banner emitted to stderr when `--no-engine` is passed in v7.0+. The
 *  dispatcher rejects with `invalid_config` exit 1 immediately after. */
export const ENGINE_OFF_REMOVED_MESSAGE =
  '[deprecation] --no-engine was removed in v7.0. The engine is always on. See docs/v7/breaking-changes.md.';

/** Banner emitted to stderr (once per process) when
 *  `CLAUDE_AUTOPILOT_ENGINE` is set to an off-style value. The env value
 *  is otherwise ignored — softer than the `--no-engine` rejection
 *  because env vars in CI are sticky and silently breaking every
 *  v6.x → v7 upgrade in CI on day one would burn user trust. */
export const ENGINE_OFF_ENV_REMOVED_MESSAGE =
  '[deprecation] CLAUDE_AUTOPILOT_ENGINE=off has no effect in v7.0+ (engine is always on). Unset the env var.';
