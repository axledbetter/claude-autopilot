// src/core/migrate/contract.ts

/** Wire format version for the envelope + result artifact. Skills must
 *  declare a compatible skill_runtime_api_version. */
export const ENVELOPE_CONTRACT_VERSION = '1.0' as const;

/** Hard cap on result artifact size. Larger output rejected with
 *  reasonCode: 'result-too-large'. */
export const RESULT_ARTIFACT_MAX_BYTES = 1_048_576;

/** Stdout fallback marker prefix; nonce-bound. Format:
 *  @@AUTOPILOT_RESULT_BEGIN:<nonce>@@\n{...}\n@@AUTOPILOT_RESULT_END:<nonce>@@
 *  Disabled by default; opt-in via skill manifest stdoutFallback: true. */
export const STDOUT_MARKER_BEGIN_PREFIX = '@@AUTOPILOT_RESULT_BEGIN:';
export const STDOUT_MARKER_END_PREFIX = '@@AUTOPILOT_RESULT_END:';
export const STDOUT_MARKER_SUFFIX = '@@';

/** Reserved sideEffectsPerformed enum (v1). Skills cannot invent values;
 *  new entries land via package release. */
export const RESERVED_SIDE_EFFECTS = [
  'types-regenerated',
  'migration-ledger-updated',
  'schema-cache-refreshed',
  'seed-data-applied',
  'snapshot-written',
  'no-side-effects',
] as const;

/** Shell metacharacters forbidden in CommandSpec args[] entries. The
 *  structured argv contract executes via spawn(shell:false), so these
 *  characters provide no benefit and are rejected at schema validation. */
export const SHELL_METACHARS = /[|;&><`$()]/;

/** Trusted root prefixes for skill resolution. resolved skill paths must
 *  start with one of these (after realpath canonicalization) — prevents
 *  alias map entries from escaping the repo or installed package dir. */
export const TRUSTED_SKILL_ROOTS = ['skills/', 'node_modules/'] as const;

/** Default temp directory permissions for per-invocation result artifact
 *  storage. 0700 = rwx for owner only. */
export const RESULT_TEMPDIR_MODE = 0o700;
