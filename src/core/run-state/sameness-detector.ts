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

/** Normalize a free-form error message: trim, collapse all runs of
 *  whitespace (including newlines/tabs) to single spaces, and truncate to
 *  `FINGERPRINT_MESSAGE_MAX` characters. The truncation is what makes
 *  the fingerprint stable across runs whose messages differ only in
 *  trailing stack-frame noise. */
function normalizeMessage(msg: string): string {
  if (typeof msg !== 'string') {
    return '';
  }
  const collapsed = msg.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= FINGERPRINT_MESSAGE_MAX) {
    return collapsed;
  }
  return collapsed.slice(0, FINGERPRINT_MESSAGE_MAX);
}

/** Compute a stable fingerprint for a single failure occurrence. The
 *  returned `hash` is the equality key — two failures with equal hashes
 *  are considered "the same failure" for retry-loop escalation purposes. */
export function computeFingerprint(
  input: ComputeFingerprintInput,
): FailureFingerprint {
  const phase = input.phase;
  const errorType = (input.errorType ?? '').toString();
  const errorLocation = (input.errorLocation ?? '').toString();
  const errorMessage = normalizeMessage(input.errorMessage ?? '');

  // Pipe-delimited because none of the four fields legitimately contain '|'
  // in practice (file paths use '/', test names use spaces, codex IDs are
  // alphanumeric). Keeping the delimiter outside the message ensures
  // truncation can't accidentally re-introduce ambiguity.
  const canonical = `${phase}|${errorType}|${errorLocation}|${errorMessage}`;
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
