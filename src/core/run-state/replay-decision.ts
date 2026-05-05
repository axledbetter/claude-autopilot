// src/core/run-state/replay-decision.ts
//
// v6 Phase 6 — pure decision function for "should this phase replay?".
//
// Inputs are the persisted facts of a prior phase attempt (success count,
// idempotent / hasSideEffects declarations, externalRefs) plus the live
// readback results from `provider-readback.ts`. Output is one of four
// decisions, plus the refs + readbacks the decision was based on so callers
// can surface them in `phase.needs-human` events for human triage.
//
// This file is deliberately pure: it does NOT execute readbacks itself
// (caller passes them in), it does NOT consult disk, it does NOT throw on
// any input shape. Easy to unit-test exhaustively against the spec's
// per-phase replay table.
//
// Spec: docs/specs/v6-run-state-engine.md "Idempotency rules + external
// operation ledger (Codex CRITICAL #2)" — the replay matrix.

import type { ExternalRef } from './types.ts';
import type { ReadbackResult } from './provider-readback.ts';

/** Decision the engine should take when replaying / resuming a phase. */
export type ReplayDecisionKind =
  /** Run the phase body. Default for fresh attempts and post-failure retries. */
  | 'retry'
  /** Don't run; treat as already-done. Engine returns prior output / snapshot. */
  | 'skip-already-applied'
  /** Don't run; can't safely decide. Engine emits phase.needs-human + throws. */
  | 'needs-human'
  /** Don't run; explicit user/CI signal to give up. Engine throws abort code. */
  | 'abort';

export interface ReplayDecision {
  decision: ReplayDecisionKind;
  /** Single-line human-readable explanation. Embedded into needs-human events
   *  and surface in `runs resume` output. */
  reason: string;
  /** External refs the decision considered. Echoed back so CI/humans can
   *  inspect them without re-reading the events log. */
  refsConsulted: ExternalRef[];
  /** Per-ref readback results. Empty array when the decision was made
   *  without consulting readbacks (e.g. retry on no-prior-success). */
  readbacksConsulted: ReadbackResult[];
}

/** Inputs to `decideReplay`. All fields required so callers can't accidentally
 *  drop a signal. Keep in lockstep with runPhase's gating logic. */
export interface ReplayDecisionInput {
  /** Phase name — for the reason string only; no behavior depends on it. */
  phaseName: string;
  /** True iff prior `phase.success` event exists for this phaseIdx. */
  hasPriorSuccess: boolean;
  /** Total attempts recorded in state.json for this phaseIdx (failed +
   *  succeeded). Used only for the `reason` string when there's no prior
   *  success but priorAttempts > 0 — distinguishes "first attempt" from
   *  "post-failure retry" so users running `runs resume` get an accurate
   *  description. No behavior depends on this; it's a presentation field.
   *  Defaults to 0 when omitted (Bugbot LOW PR #91 fold-in). */
  priorAttempts?: number;
  /** Mirrors RunPhase.idempotent declared at registration. */
  idempotent: boolean;
  /** Mirrors RunPhase.hasSideEffects declared at registration. */
  hasSideEffects: boolean;
  /** All externalRefs persisted for this phaseIdx across prior attempts. */
  externalRefs: ExternalRef[];
  /** Readback results, one per externalRef in the same order. May be empty
   *  when the caller is doing pure-state lookup (CLI `runs resume`) — in
   *  that case any side-effect-phase prior success collapses to needs-human
   *  because we have no live confirmation. */
  readbacks: ReadbackResult[];
  /** When true the user/CI explicitly asked to override needs-human. The
   *  engine emits a `replay.override` event; this function flips the
   *  decision to retry regardless of state. */
  forceReplay: boolean;
}

/** Decide what to do with a (re-)attempt of a phase. Pure; safe to call
 *  during CLI lookup AND inside runPhase. The decision matrix mirrors the
 *  spec's per-phase replay table:
 *
 *    | prior success | idempotent | sideEffects | refs       | readback all valid | -> decision |
 *    | no            | -          | -           | -          | -                  | retry       |
 *    | yes           | yes        | -           | -          | -                  | skip        |
 *    | yes           | no         | no          | -          | -                  | skip        |
 *    | yes           | no         | yes         | empty      | -                  | needs-human |
 *    | yes           | no         | yes         | non-empty  | all valid          | skip        |
 *    | yes           | no         | yes         | non-empty  | any missing/stale  | needs-human |
 *
 *  forceReplay = true overrides everything → retry. */
export function decideReplay(input: ReplayDecisionInput): ReplayDecision {
  const refsConsulted = [...input.externalRefs];
  const readbacksConsulted = [...input.readbacks];

  // Override path — caller already gated this on user/CI consent. Engine
  // emits replay.override on this branch.
  if (input.forceReplay) {
    return {
      decision: 'retry',
      reason: `forceReplay override: ${input.phaseName} will re-execute despite prior state`,
      refsConsulted,
      readbacksConsulted,
    };
  }

  // No prior success → fresh attempt or post-failure retry. Always safe.
  if (!input.hasPriorSuccess) {
    const priorAttempts = input.priorAttempts ?? 0;
    const reason = priorAttempts > 0
      ? `${input.phaseName} previous attempt(s) failed (${priorAttempts}) — retry safe`
      : `${input.phaseName} has no prior success — first attempt`;
    return {
      decision: 'retry',
      reason,
      refsConsulted,
      readbacksConsulted: [],
    };
  }

  // Prior success + declared idempotent → safe to short-circuit. The phase
  // contract promises the prior output is durable / retrievable.
  if (input.idempotent) {
    return {
      decision: 'skip-already-applied',
      reason: `${input.phaseName} previously succeeded and is idempotent — replay short-circuits`,
      refsConsulted,
      readbacksConsulted: [],
    };
  }

  // Prior success + no side effects → still safe to skip. The phase
  // produced no observable platform state; replay would just re-do the
  // identical no-side-effect work.
  if (!input.hasSideEffects) {
    return {
      decision: 'skip-already-applied',
      reason: `${input.phaseName} previously succeeded with no side effects — skip-already-applied`,
      refsConsulted,
      readbacksConsulted: [],
    };
  }

  // Prior success + side effects + no refs → we can't reach the platform of
  // record to confirm anything. Bubble to a human; the spec is explicit
  // that missing refs always route to needs-human.
  if (input.externalRefs.length === 0) {
    return {
      decision: 'needs-human',
      reason: `${input.phaseName} previously succeeded with side effects but recorded no externalRefs — cannot verify, needs human review`,
      refsConsulted,
      readbacksConsulted: [],
    };
  }

  // Prior success + side effects + refs but no readbacks supplied (CLI
  // lookup mode): we must NOT silently skip. Surface as needs-human so the
  // CLI prediction matches what runPhase will do under live conditions.
  if (input.readbacks.length === 0) {
    return {
      decision: 'needs-human',
      reason: `${input.phaseName} previously succeeded with side effects; no live readback was performed — needs human review (or pass --force-replay)`,
      refsConsulted,
      readbacksConsulted: [],
    };
  }

  // Refs + readbacks both present — adjudicate per readback validity.
  const stale = readbacksConsulted.filter(rb => !isReadbackValid(rb));
  if (stale.length > 0) {
    const summary = stale
      .map(rb => `${rb.refKind}=${rb.refId} state=${rb.currentState}`)
      .join(', ');
    return {
      decision: 'needs-human',
      reason: `${input.phaseName} previously succeeded but ${stale.length} ref(s) are stale or missing on the platform: ${summary}`,
      refsConsulted,
      readbacksConsulted,
    };
  }

  return {
    decision: 'skip-already-applied',
    reason: `${input.phaseName} previously succeeded; all ${readbacksConsulted.length} platform ref(s) verified live — skip-already-applied`,
    refsConsulted,
    readbacksConsulted,
  };
}

/** A readback is "valid" — i.e. authorizes a skip-already-applied — when the
 *  platform confirms the ref still exists AND its current state is one of
 *  the "still represents the prior side effect" set. The deny-set:
 *  - 'closed' / 'rolled-back' / 'failed' → side effect was reverted;
 *    replaying would create a new artifact.
 *  - 'unknown' → fail-closed; we can't make a confident assertion.
 *  Anything else (open / merged / live) is treated as "ref still represents
 *  the prior side effect" — replay would be a duplicate. */
function isReadbackValid(rb: ReadbackResult): boolean {
  if (!rb.existsOnPlatform) return false;
  switch (rb.currentState) {
    case 'open':
    case 'merged':
    case 'live':
      return true;
    case 'closed':
    case 'rolled-back':
    case 'failed':
    case 'unknown':
    default:
      return false;
  }
}
