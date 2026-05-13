// src/core/run-state/sameness-detector.ts
//
// Retry-loop sameness detector — escalates when the same failure fingerprint
// fires twice in a row during a retry loop (validate, codex PR review, or
// bugbot). The pipeline halts when retries make no progress, even if you have
// retries remaining.
//
// Issue: #181 (v7.11.0 — released as v7.10.0).
//
// Design:
//   - `FailureFingerprint` is a hashable identity for a failure. Same hash
//     across two attempts means "we tried, failed for the same reason, fixed
//     nothing". That is the signal to stop burning retries and surface to a
//     human.
//   - Storage is in-memory only. The v6 run-state events.ndjson integration
//     is tracked separately as issue #180; explicitly deferred here so the
//     pipeline can adopt the detector without waiting on persistence.
//   - All functions are pure (modulo `crypto.createHash`), making this easy
//     to unit-test under node:test.
//
// Who calls this:
//   The detector is consumed by the autopilot skill agent (an LLM following
//   `skills/autopilot/SKILL.md`), NOT by the `scripts/validate.ts`,
//   `scripts/codex-pr-review.ts`, or `scripts/bugbot.ts` CLI scripts. Those
//   scripts are stateless per-invocation; the retry loop lives one layer
//   above them, inside the skill execution. Wiring this into the CLIs would
//   not catch repeated failures because each CLI invocation is a clean
//   process. The skill agent is the durable retry-loop scope.

import { createHash } from 'node:crypto';

/** Which loop in the autopilot pipeline produced the failure. The three
 *  Step-4 / Step-7 / Step-8 retry loops in `skills/autopilot/SKILL.md` are
 *  the call sites that consult the detector before consuming a retry. */
export type FailurePhase = 'validate' | 'codex-review' | 'bugbot';

/** A normalized identity for a single failure occurrence. Two fingerprints
 *  are "the same failure" iff their `hash` is equal — phase, errorType,
 *  errorLocation, and the truncated/normalized errorMessage all feed into
 *  the hash, so any meaningful change between retries produces a new hash. */
export interface FailureFingerprint {
  phase: FailurePhase;
  /** Discriminator inside the phase. Examples:
   *   - validate: 'tsc_error' | 'test_failure' | 'lint_error'
   *   - codex-review: 'codex_critical' | 'codex_warning'
   *   - bugbot: 'bugbot_high' | 'bugbot_medium' */
  errorType: string;
  /** Where the failure points. `file:line` for tsc/lint, test name for tests,
   *  finding-id for codex, comment-id for bugbot. Whatever uniquely locates
   *  the problem within the phase. */
  errorLocation: string;
  /** First 200 chars of the canonical message, whitespace-collapsed. The
   *  truncation is what makes the fingerprint stable across runs that differ
   *  only in trailing stack-frame noise. */
  errorMessage: string;
  /** sha256 hex of `${phase}|${errorType}|${errorLocation}|${errorMessage}`.
   *  This is the equality key. */
  hash: string;
}

/** Maximum length of the normalized error message that feeds the hash.
 *  Anything beyond this is dropped — picked to match the issue spec and to
 *  keep the hash stable across runs that differ only in trailing noise. */
export const FINGERPRINT_MESSAGE_MAX = 200;

export interface ComputeFingerprintInput {
  phase: FailurePhase;
  errorType: string;
  errorLocation: string;
  errorMessage: string;
}

/** Strip known volatile / per-run tokens from a free-form string so that two
 *  retries that differ only in transient data (UUIDs, ports, epoch
 *  timestamps, ISO timestamps, hex SHAs, absolute temp paths) produce the
 *  same canonical form. Order matters — broader patterns run first so they
 *  can swallow embedded delimiters before narrower patterns see them.
 *
 *  Exported because callers building locations/messages outside this module
 *  may want to apply the same scrubbing before constructing a fingerprint
 *  (e.g. when assembling an `errorLocation` from a tool output that embeds
 *  a run-id). */
export function stripVolatileTokens(s: string): string {
  if (typeof s !== 'string') return '';
  return (
    s
      // ISO-8601 timestamps (e.g. 2026-05-13T07:00:00.000Z)
      .replace(
        /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
        '<ts>',
      )
      // 13-digit epoch ms
      .replace(/\b\d{13}\b/g, '<ts>')
      // UUIDs (v1-v5)
      .replace(
        /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
        '<uuid>',
      )
      // 40-char (sha1) or 64-char (sha256) hex digests
      .replace(/\b[0-9a-fA-F]{40}\b/g, '<sha>')
      .replace(/\b[0-9a-fA-F]{64}\b/g, '<sha>')
      // macOS / Linux temp paths (/tmp, /var/folders) up to the next whitespace
      .replace(/\/(?:tmp|var\/folders)\/[^\s'"`]+/g, '<tmpdir>')
      // localhost ports like :49213
      .replace(/\b(?:127\.0\.0\.1|localhost):\d{2,5}\b/g, '<host:port>')
  );
}

/** Normalize a free-form error message: strip volatile tokens, trim, collapse
 *  all runs of whitespace (including newlines/tabs) to single spaces, and
 *  truncate to `FINGERPRINT_MESSAGE_MAX` characters. The truncation is what
 *  makes the fingerprint stable across runs whose messages differ only in
 *  trailing stack-frame noise. */
function normalizeMessage(msg: string): string {
  if (typeof msg !== 'string') {
    return '';
  }
  const scrubbed = stripVolatileTokens(msg);
  const collapsed = scrubbed.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= FINGERPRINT_MESSAGE_MAX) {
    return collapsed;
  }
  return collapsed.slice(0, FINGERPRINT_MESSAGE_MAX);
}

/** Normalize an `errorLocation` (file path / test name / etc.) by applying
 *  the same volatile-token scrubbing as the message, plus whitespace trim.
 *  Does NOT truncate — locations are short by construction. */
function normalizeLocation(loc: string): string {
  if (typeof loc !== 'string') return '';
  return stripVolatileTokens(loc).trim();
}

/** Compute a stable fingerprint for a single failure occurrence. The
 *  returned `hash` is the equality key — two failures with equal hashes
 *  are considered "the same failure" for retry-loop escalation purposes. */
export function computeFingerprint(
  input: ComputeFingerprintInput,
): FailureFingerprint {
  const phase = input.phase;
  const errorType = (input.errorType ?? '').toString();
  const errorLocation = normalizeLocation((input.errorLocation ?? '').toString());
  const errorMessage = normalizeMessage(input.errorMessage ?? '');

  // Use JSON.stringify of a 4-tuple as the canonical pre-hash serialization.
  // This is unambiguous under any field content — pipe characters, quotes,
  // braces, embedded JSON, etc. all serialize unambiguously and cannot
  // produce collisions across different `[phase, type, location, message]`
  // tuples. (Earlier drafts used a pipe-delimited string; that was vulnerable
  // to delimiter ambiguity when, e.g., a test name legitimately contained
  // '|'. The JSON form has no such edge case.)
  const canonical = JSON.stringify([phase, errorType, errorLocation, errorMessage]);
  const hash = createHash('sha256').update(canonical).digest('hex');

  return { phase, errorType, errorLocation, errorMessage, hash };
}

/** Compare two fingerprints. They are "the same failure" iff their hashes
 *  match — phase/type/location/message all feed the hash, so equal hash
 *  means equal across all observable identity. */
export function isSameFailure(
  a: FailureFingerprint,
  b: FailureFingerprint,
): boolean {
  if (!a || !b) return false;
  return a.hash === b.hash;
}

export interface EscalationDecision {
  /** True iff the caller should STOP consuming retries and surface to a
   *  human, because the last two recorded attempts produced the same
   *  failure (no progress between retries). */
  escalate: boolean;
  /** Set when `escalate` is true — human-readable explanation. */
  reason?: string;
  /** Set when `escalate` is true — the offending fingerprint that fired
   *  twice. Callers should display this to the operator so they can see
   *  what's stuck. */
  fingerprint?: FailureFingerprint;
}

/** Decide whether to escalate a retry loop to a human, given the history
 *  of failure fingerprints recorded so far in this retry loop.
 *
 *  Rule (per issue #181): escalate iff `history.length >= 2` AND the last
 *  two fingerprints have identical hashes. Anything else — first failure,
 *  different failures across retries, longer streak of different failures
 *  — returns `{ escalate: false }`.
 *
 *  Rationale: a single retry on the SAME failure means we tried, fixed
 *  nothing, and failed identically. Retries that keep failing on
 *  *different* things are still making progress (each one is a new fix).
 *  Only no-progress retries should consume the escalation budget. */
export function shouldEscalate(
  history: readonly FailureFingerprint[],
): EscalationDecision {
  if (!Array.isArray(history) || history.length < 2) {
    return { escalate: false };
  }
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (!last || !prev) {
    return { escalate: false };
  }
  if (isSameFailure(prev, last)) {
    return {
      escalate: true,
      reason:
        `Retry loop produced the same failure twice in a row ` +
        `(phase=${last.phase}, errorType=${last.errorType}, ` +
        `errorLocation=${last.errorLocation}). The pipeline is not making ` +
        `progress — surfacing to human instead of consuming another retry.`,
      fingerprint: last,
    };
  }
  return { escalate: false };
}
