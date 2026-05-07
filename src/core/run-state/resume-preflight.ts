// src/core/run-state/resume-preflight.ts
//
// v6.2.1 — orchestrator resume preflight for side-effecting phases.
//
// Background — the v6.2.1 side-effect idempotency contract requires every
// `hasSideEffects: true` phase to declare two ref kind sets:
//
//   - `preEffectRefKinds`  — recorded BEFORE the side effect runs.
//   - `postEffectRefKinds` — recorded AFTER the side effect completes.
//
// On resume of a runId the orchestrator must consult the persisted refs +
// the platform of record (via `verifyRefs`) before re-invoking the phase
// body. This module owns that decision.
//
// The decision matrix (per spec "Resume preflight pseudocode"):
//
//   - All postEffect refs read back as `merged` / `live`
//     ⇒ `skip-already-applied` — orchestrator emits `phase.success
//       { replayed: true, reason: 'side-effect-already-applied' }` and
//       advances. NO retry.
//   - PreEffect ref read back as `open` AND postEffect refs incomplete
//     ⇒ `retry` — orchestrator runs the phase body normally; the phase's
//       own ledger / preflight handles dedup against the partial state.
//   - Otherwise (no prior success, ambiguous, or readback unknown)
//     ⇒ `needs-human` — orchestrator emits `replay.override` event and
//       throws `GuardrailError('needs_human')`.
//
// Fresh runs (no prior phase.success for this phaseIdx) get `proceed-fresh`
// — the orchestrator just runs the phase normally.

import type { ExternalRef } from './types.ts';
import type { ReadbackResult } from './provider-readback.ts';
import { verifyRefs as defaultVerifyRefs } from './provider-readback.ts';

/** What the orchestrator should do for this phase on resume. */
export type ResumeDecision =
  /** No prior success → run the phase normally (no preflight needed). */
  | { kind: 'proceed-fresh' }
  /** All postEffect refs `merged`/`live` → emit phase.success with
   *  `replayed: true` and skip the phase body. */
  | { kind: 'skip-already-applied'; readback: ReadbackResult[]; reason: string }
  /** PreEffect ref `open` + postEffect incomplete → re-run the phase body;
   *  its own ledger handles partial-state dedup. */
  | { kind: 'retry'; readback: ReadbackResult[]; reason: string }
  /** Ambiguous state → emit replay.override + throw needs_human. */
  | { kind: 'needs-human'; readback: ReadbackResult[]; reason: string; refsConsulted: ExternalRef[] };

export interface ResumePreflightInput {
  /** The phase's contract — read out of `PHASE_REGISTRY[name]`. Empty
   *  arrays are valid (e.g. `pr` declares post-effect = []). */
  preEffectRefKinds: readonly string[];
  postEffectRefKinds: readonly string[];
  /** Did the prior orchestrator attempt record `phase.success` for this
   *  phaseIdx? When false, we return `proceed-fresh` immediately. */
  priorPhaseSuccess: boolean;
  /** Refs persisted by the prior attempt — both pre-effect and post-effect
   *  kinds, in event order. The preflight filters them by kind to map
   *  to the contract. */
  priorRefs: readonly ExternalRef[];
  /** Test seam — replace `verifyRefs` so unit tests don't need the real
   *  github / supabase readbacks. Production callers omit this. */
  verifyRefsImpl?: (refs: readonly ExternalRef[]) => Promise<ReadbackResult[]>;
}

/**
 * Make the resume decision for one side-effecting phase.
 *
 * The contract:
 *   - When `priorPhaseSuccess === false` → `proceed-fresh` (no preflight).
 *   - When `priorRefs` is empty AND we have a prior phase.success →
 *     `needs-human` (the phase claimed success but didn't persist any
 *     ref — corrupted state we shouldn't auto-retry).
 *   - When all refs whose kind is in `postEffectRefKinds` read back as
 *     `merged` / `live` AND postEffect is non-empty → `skip-already-applied`.
 *   - When at least one preEffect ref reads back as `open` AND not all
 *     post-effect refs merged → `retry`.
 *   - Otherwise → `needs-human`.
 *
 * `pr`'s contract has `postEffectRefKinds: []`. For that case the
 * pre-effect ref (`github-pr`) doubles as the reconciliation ref — we
 * inspect IT against `merged`/`open` semantics. Any other state →
 * needs-human.
 */
export async function resumePreflight(
  input: ResumePreflightInput,
): Promise<ResumeDecision> {
  if (!input.priorPhaseSuccess && input.priorRefs.length === 0) {
    return { kind: 'proceed-fresh' };
  }

  const verify = input.verifyRefsImpl ?? defaultVerifyRefs;
  const readback = input.priorRefs.length > 0 ? await verify(input.priorRefs) : [];

  // postEffect path — if the contract declares post-effect kinds, the
  // pre-effect breadcrumb's readback state is authoritative for the
  // batch's "did all the planned work land?" question. Post-effect refs
  // alone aren't authoritative because the resume doesn't know the total
  // planned set just from the persisted ref count (a partial crash
  // persists 3 of 5 migration-version refs and 0 readback for the missing
  // 2 — counting the persisted set against itself always says "complete").
  // The batch readback is the source of truth: it queries the dispatcher's
  // ledger for the planned set vs the applied set.
  if (input.postEffectRefKinds.length > 0) {
    const preRefs = readback.filter(r =>
      input.preEffectRefKinds.includes(r.refKind as string),
    );
    const postRefs = readback.filter(r =>
      input.postEffectRefKinds.includes(r.refKind as string),
    );

    // Skip-already-applied: pre-effect breadcrumb confirms `merged` AND
    // every persisted post-effect ref is live/merged. The pre-effect's
    // `merged` state comes from the batch readback comparing planned to
    // applied — so we trust it as the cross-set check.
    const preMerged = preRefs.length > 0 && preRefs.every(r =>
      r.currentState === 'merged' || r.currentState === 'live',
    );
    const postAllLive = postRefs.every(r =>
      r.currentState === 'merged' || r.currentState === 'live',
    );
    if (preMerged && postAllLive) {
      return {
        kind: 'skip-already-applied',
        readback,
        reason: `pre-effect ref reports merged + ${postRefs.length} post-effect ref(s) live`,
      };
    }

    // Retry: pre-effect breadcrumb is `open` (some planned items still
    // pending). The phase body's own ledger guard handles dedup of the
    // already-applied items.
    const preOpen = preRefs.some(r => r.currentState === 'open');
    if (preOpen) {
      return {
        kind: 'retry',
        readback,
        reason: 'pre-effect breadcrumb open + post-effect refs incomplete',
      };
    }
  } else {
    // Empty postEffectRefKinds — pre-effect ref doubles as reconciliation.
    // Used by `pr`: the github-pr ref IS the post-effect ref.
    const preRefs = readback.filter(r =>
      input.preEffectRefKinds.includes(r.refKind as string),
    );
    if (preRefs.length > 0 && preRefs.every(r =>
      r.currentState === 'merged' || r.currentState === 'live' || r.currentState === 'open',
    )) {
      // For pr: open/merged both mean "the PR exists, don't recreate it."
      return {
        kind: 'skip-already-applied',
        readback,
        reason: `pre-effect ref doubles as reconciliation; all ${preRefs.length} report live/merged/open`,
      };
    }
  }

  // Anything else — refs missing, closed without merge, unknown — punt.
  return {
    kind: 'needs-human',
    readback,
    refsConsulted: [...input.priorRefs],
    reason: readback.length === 0
      ? 'prior phase.success exists but no externalRefs persisted'
      : 'readback could not confirm skip-already-applied or retry-safe',
  };
}
