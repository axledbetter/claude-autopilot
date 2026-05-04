// src/core/run-state/phase-runner.ts
//
// v6 Phase 2 — phase wrapper / lifecycle layer.
//
// `runPhase` is the orchestrator that wraps a single `RunPhase` invocation:
//
//   1. emit phase.start (with attempt counter + idempotent/hasSideEffects
//      flags)
//   2. call phase.run(input, ctx) — the user's phase body
//   3. on success → emit phase.success + write phases/<name>.json snapshot
//   4. on throw   → emit phase.failed + write a failed snapshot + rethrow
//
// Idempotency / side-effect gating:
//
//   - If a prior phase.success exists for this (runDir, phaseIdx) AND
//     `phase.idempotent === true`, the runner short-circuits with a
//     `phase.skipped` event-shaped recording (we use the existing
//     phase.success replay-equivalence — a one-shot phase.success is OK
//     because the snapshot will be rewritten with attempts++ and a
//     "skipped"-flavored note in `meta`, plus we emit a `run.warning`
//     with reason `idempotent-replay` so observers can attribute the
//     short-circuit). See "skipped variant" below for the exact event.
//   - If a prior phase.success exists AND `phase.hasSideEffects === true`,
//     the runner refuses without `--force-replay`: it throws GuardrailError
//     `needs_human` carrying the prior externalRefs in `details` so a CI /
//     human consumer can resolve.
//
// What this file deliberately does NOT do (Phase 4+ work):
//
//   - Budget enforcement. `estimateCost` is part of the interface but the
//     policy check lives in a future budget enforcer.
//   - Provider read-back ("is PR #123 still open?"). Phase 6 wires `onResume`
//     to consult externalRefs + read back; Phase 2 just records refs.
//   - Locking. `runPhase` does NOT acquire the per-run advisory lock — the
//     caller (createRun / future resume verb) holds it for the lifetime of
//     the run. We just need a writerId to stamp events; we accept it from
//     parentCtx.
//
// Spec: docs/specs/v6-run-state-engine.md "Phase contract", "Run lifecycle",
// "Idempotency rules + external operation ledger".

import * as readline from 'node:readline';
import { GuardrailError } from '../errors.ts';
import { checkPhaseBudget, type BudgetCheck, type BudgetConfig } from './budget.ts';
import { appendEvent, readEvents } from './events.ts';
import {
  buildPhaseContext,
  collectExternalRefs,
  countPhaseAttempts,
  countPhaseSuccesses,
  sumPhaseCost,
  type PhaseContext,
} from './phase-context.ts';
import { writePhaseSnapshot } from './snapshot.ts';
import {
  RUN_STATE_SCHEMA_VERSION,
  type ExternalRef,
  type PhaseSnapshot,
  type RunEvent,
  type WriterId,
} from './types.ts';

// ----------------------------------------------------------------------------
// Public surface
// ----------------------------------------------------------------------------

/** What `RunPhase.onResume` receives when a previous attempt of the same
 *  phaseIdx exists. Phase 6 will fully wire this; in Phase 2 we expose the
 *  shape so callers can author against it without a later breaking change. */
export interface PhaseResumeContext {
  runDir: string;
  runId: string;
  phaseIdx: number;
  /** All externalRefs recorded for this phase across prior attempts. */
  externalRefs: ExternalRef[];
  /** How many `phase.start` events have been observed for this phaseIdx
   *  (i.e. the attempt count of the prior run). */
  attempts: number;
  /** Whether the previous attempt was a phase.success (was the phase already
   *  done before the current resume began?). */
  succeeded: boolean;
}

/** The phase contract — the only object an existing pipeline needs to
 *  implement to be run by the engine. Existing phases are wrapped, NOT
 *  rewritten; in Phase 2 we ship the wrapper but no actual phase consumes
 *  it yet. */
export interface RunPhase<I = unknown, O = unknown> {
  readonly name: string;
  readonly idempotent: boolean;
  readonly hasSideEffects: boolean;
  estimateCost?(input: I): { lowUSD: number; highUSD: number };
  run(input: I, ctx: PhaseContext): Promise<O>;
  /** Called when resuming after a previous failure / completion. Decides
   *  whether to skip, retry, abort, or bubble to a human. Default behavior
   *  (when this method is absent) is encoded in `runPhase` itself: idempotent
   *  phases retry, side-effecting phases require `--force-replay`. */
  onResume?(prev: PhaseResumeContext): Promise<'skip' | 'retry' | 'abort' | 'needs-human'>;
}

/** What the caller passes in. We require runDir/runId/writerId to be already
 *  established (the run-creator already did this). */
export interface ParentRunContext {
  runDir: string;
  runId: string;
  writerId: WriterId;
  /** Index of this phase within the run's `phases[]`. */
  phaseIdx: number;
  /** When true, override the side-effects gate even if a prior success
   *  exists. Records a `run.warning` event noting the override. */
  forceReplay?: boolean;
  /** Phase 4 — optional budget enforcement config. When omitted the
   *  runner is back-compat: no `budget.check` event, no preflight, no
   *  rejection. When present, the runner consults `checkPhaseBudget`
   *  BEFORE emitting `phase.start` and may throw `budget_exceeded`. */
  budget?: BudgetConfig;
  /** When true, a `pause` budget decision becomes `hard-fail` instead of
   *  prompting the user. Callers in CI / `--json` mode MUST set this.
   *  Default: false (interactive). */
  nonInteractive?: boolean;
  /** Override the interactive confirm prompt. Returning `true` proceeds,
   *  `false` rejects. Mainly a test seam; the default uses readline. */
  confirmBudgetPause?: (check: BudgetCheck) => Promise<boolean>;
}

// Re-export the context surface so callers don't need to import from two
// modules to type their phase.
export type { PhaseContext } from './phase-context.ts';

// ----------------------------------------------------------------------------
// runPhase — the orchestrator
// ----------------------------------------------------------------------------

/** Run a single phase with full lifecycle instrumentation.
 *
 *  Emits, in order:
 *    phase.start  — always (unless idempotent short-circuit fires first)
 *    phase.cost   — zero or more, emitted by the phase via ctx.emitCost
 *    phase.externalRef — zero or more, via ctx.emitExternalRef
 *    phase.success | phase.failed — exactly one
 *
 *  Writes phases/<name>.json after either terminal event so a crash between
 *  the event and the snapshot is recoverable from events.ndjson. */
export async function runPhase<I, O>(
  phase: RunPhase<I, O>,
  input: I,
  parentCtx: ParentRunContext,
): Promise<O> {
  const {
    runDir,
    runId,
    writerId,
    phaseIdx,
    forceReplay,
    budget,
    nonInteractive,
    confirmBudgetPause,
  } = parentCtx;

  // -- Idempotency / side-effect gating ----------------------------------
  // We replay events.ndjson once up-front to detect prior outcomes for this
  // phaseIdx. Cheap — Phase 1 already reads the whole file for replayState.
  const prior = readEvents(runDir);
  const priorSuccessCount = countPhaseSuccesses(prior.events, phaseIdx);
  const priorAttemptCount = countPhaseAttempts(prior.events, phaseIdx);
  const priorRefs = collectExternalRefs(prior.events, phaseIdx);

  if (priorSuccessCount > 0) {
    if (phase.idempotent) {
      // Short-circuit. Emit a `run.warning` so consumers see the skip
      // (we don't have a dedicated phase.skipped variant in the Phase 1
      // event union — this is intentional: replay produces the same
      // PhaseSnapshot regardless of how many times the runner short-
      // circuited, so the durable log doesn't need a separate event).
      // Phase 2 invariant: the snapshot's `attempts` is bumped and `meta`
      // records the skip so debug tooling can surface it.
      appendEvent(
        runDir,
        {
          event: 'run.warning',
          message: `phase ${phase.name} short-circuited on idempotent-replay`,
          details: {
            phase: phase.name,
            phaseIdx,
            priorSuccesses: priorSuccessCount,
            reason: 'idempotent-replay',
          },
        },
        { writerId, runId },
      );

      // Refresh + re-persist snapshot with the bumped attempts/meta.
      const snapshot: PhaseSnapshot = {
        schema_version: RUN_STATE_SCHEMA_VERSION,
        name: phase.name,
        index: phaseIdx,
        status: 'succeeded',
        idempotent: phase.idempotent,
        hasSideEffects: phase.hasSideEffects,
        costUSD: sumPhaseCost(prior.events, phaseIdx),
        attempts: priorAttemptCount, // unchanged — we did NOT start
        artifacts: [],
        externalRefs: priorRefs,
        meta: { skipped: true, reason: 'idempotent-replay' },
      };
      writePhaseSnapshot(runDir, snapshot);

      // We don't re-execute, but we owe the caller an O. The contract is
      // that an idempotent phase's prior output is durably recorded
      // somewhere external (Phase 6 will wire onResume to surface it).
      // For Phase 2 we throw a typed error if the caller actually depends
      // on the return value — surfaces clearly rather than silently
      // returning `undefined as O`.
      throw new GuardrailError(
        `phase ${phase.name} was already completed and is idempotent — ` +
          `runPhase short-circuited; the caller should consult phases/${phase.name}.json or onResume.`,
        {
          code: 'superseded',
          provider: 'run-state',
          details: { runDir, phaseIdx, priorRefs },
        },
      );
    }

    if (phase.hasSideEffects && !forceReplay) {
      // Refuse without explicit override.
      appendEvent(
        runDir,
        {
          event: 'phase.needs-human',
          phase: phase.name,
          phaseIdx,
          reason: 'replay-requires-human-approval',
          nextActions: [
            `Inspect prior externalRefs for phase ${phase.name}.`,
            `Re-run with --force-replay if you accept the risk of duplicate side effects.`,
          ],
        },
        { writerId, runId },
      );
      throw new GuardrailError(
        `phase ${phase.name} previously succeeded with side effects; ` +
          `replay requires explicit --force-replay (or onResume === 'retry').`,
        {
          code: 'superseded',
          provider: 'run-state',
          details: {
            runDir,
            phaseIdx,
            priorRefs,
            reason: 'side-effecting-replay-needs-human',
          },
        },
      );
    }

    if (phase.hasSideEffects && forceReplay) {
      // Note the override in the log.
      appendEvent(
        runDir,
        {
          event: 'run.warning',
          message: `phase ${phase.name} replay forced via --force-replay`,
          details: { phase: phase.name, phaseIdx, priorRefs, reason: 'force-replay' },
        },
        { writerId, runId },
      );
    }
  }

  // -- Budget preflight (Phase 4) ----------------------------------------
  // Runs AFTER idempotency gating (we don't gate replays we're already
  // going to skip) and BEFORE phase.start (a rejection means the phase
  // never started — no phase.start, no phase.failed; the runner throws
  // GuardrailError budget_exceeded so the caller sees a typed failure
  // and the run can be marked aborted/paused at the orchestrator level).
  if (budget) {
    const actualSoFarUSD = sumRunCost(prior.events);
    const estimate = phase.estimateCost ? phase.estimateCost(input) : null;
    const check = checkPhaseBudget({
      budget,
      phaseName: phase.name,
      phaseIdx,
      estimatedCost: estimate,
      actualSoFarUSD,
      nonInteractive: nonInteractive === true,
    });

    appendEvent(
      runDir,
      {
        event: 'budget.check',
        phase: phase.name,
        phaseIdx,
        decision: check.decision,
        estimatedHigh: check.estimatedHigh,
        actualSoFar: check.actualSoFar,
        reserveApplied: check.reserveApplied,
        capRemaining: check.capRemaining,
        reason: check.reason,
      },
      { writerId, runId },
    );

    if (check.decision === 'hard-fail') {
      throw new GuardrailError(
        `phase ${phase.name} blocked by budget: ${check.reason}`,
        {
          code: 'budget_exceeded',
          provider: 'run-state',
          details: {
            runDir,
            phaseIdx,
            check,
          },
        },
      );
    }

    if (check.decision === 'pause') {
      const confirm = confirmBudgetPause ?? defaultConfirmBudgetPause;
      const proceed = await confirm(check);
      if (!proceed) {
        throw new GuardrailError(
          `phase ${phase.name} blocked by budget (user denied resume): ${check.reason}`,
          {
            code: 'budget_exceeded',
            provider: 'run-state',
            details: {
              runDir,
              phaseIdx,
              check,
              userDenied: true,
            },
          },
        );
      }
    }
  }

  // -- Phase start --------------------------------------------------------
  const attempt = priorAttemptCount + 1;
  const startedAtMs = Date.now();
  appendEvent(
    runDir,
    {
      event: 'phase.start',
      phase: phase.name,
      phaseIdx,
      idempotent: phase.idempotent,
      hasSideEffects: phase.hasSideEffects,
      attempt,
    },
    { writerId, runId },
  );

  // Build the per-phase context. `subPhase` is wired below.
  const ctx: PhaseContext = buildPhaseContext({
    runDir,
    runId,
    phaseName: phase.name,
    phaseIdx,
    writerId,
    subPhase: makeSubPhaseFactory({ runDir, runId, writerId, parentPhaseIdx: phaseIdx }),
  });

  // -- Execute ------------------------------------------------------------
  let output: O;
  try {
    output = await phase.run(input, ctx);
  } catch (err) {
    const durationMs = Date.now() - startedAtMs;
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof GuardrailError ? err.code : undefined;
    appendEvent(
      runDir,
      {
        event: 'phase.failed',
        phase: phase.name,
        phaseIdx,
        durationMs,
        error: message,
        ...(errorCode !== undefined ? { errorCode } : {}),
      },
      { writerId, runId },
    );
    // Re-read events to capture costs / refs the phase emitted before throw.
    const after = readEvents(runDir);
    const failedSnapshot: PhaseSnapshot = {
      schema_version: RUN_STATE_SCHEMA_VERSION,
      name: phase.name,
      index: phaseIdx,
      status: 'failed',
      idempotent: phase.idempotent,
      hasSideEffects: phase.hasSideEffects,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs,
      costUSD: sumPhaseCost(after.events, phaseIdx),
      attempts: attempt,
      lastError: message,
      artifacts: [],
      externalRefs: collectExternalRefs(after.events, phaseIdx),
    };
    writePhaseSnapshot(runDir, failedSnapshot);
    throw err;
  }

  // -- Success ------------------------------------------------------------
  const durationMs = Date.now() - startedAtMs;
  appendEvent(
    runDir,
    {
      event: 'phase.success',
      phase: phase.name,
      phaseIdx,
      durationMs,
      artifacts: [],
    },
    { writerId, runId },
  );
  // Re-read to capture costs / refs the phase emitted during run().
  const after = readEvents(runDir);
  const successSnapshot: PhaseSnapshot = {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    name: phase.name,
    index: phaseIdx,
    status: 'succeeded',
    idempotent: phase.idempotent,
    hasSideEffects: phase.hasSideEffects,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs,
    costUSD: sumPhaseCost(after.events, phaseIdx),
    attempts: attempt,
    artifacts: [],
    externalRefs: collectExternalRefs(after.events, phaseIdx),
  };
  writePhaseSnapshot(runDir, successSnapshot);
  return output;
}

// ----------------------------------------------------------------------------
// Sub-phase support
// ----------------------------------------------------------------------------

interface SubPhaseFactoryOpts {
  runDir: string;
  runId: string;
  writerId: WriterId;
  parentPhaseIdx: number;
}

/** Build a `subPhase` callable bound to a parent phase. Sub-phases use a
 *  synthetic phaseIdx derived from the parent's index plus a monotonic
 *  counter so the durable log distinguishes "outer phase 1, child 0" from
 *  "outer phase 1, child 1".
 *
 *  Encoding: subPhase index = (parentPhaseIdx + 1) * 1000 + childOrdinal.
 *  The +1 offset is critical: without it, parent index 0 (the FIRST phase
 *  of any pipeline, since createRun is 0-based) would yield child indices
 *  1, 2, 3… which collide with the regular top-level phases at those
 *  exact indices — a sub-phase's idempotency / side-effect events would
 *  then incorrectly gate the real top-level phase. Caught by Cursor
 *  Bugbot on PR #87 (HIGH). With the +1 offset:
 *    parent=0 → children 1001, 1002, 1003
 *    parent=1 → children 2001, 2002, 2003
 *    parent=N (N<999) → children (N+1)*1000+1..N
 *  Top-level pipelines have ~10 phases in practice, so the 1000 multiplier
 *  + the +1 offset keep collisions impossible at any realistic depth.
 *  Phase 6 may revisit this if nested sub-phases ever need a real tree
 *  representation. */
function makeSubPhaseFactory(opts: SubPhaseFactoryOpts): NonNullable<PhaseContext['subPhase']> {
  let childOrdinal = 0;
  return async function subPhase<SI, SO>(
    child: RunPhase<SI, SO>,
    input: SI,
  ): Promise<SO> {
    const childIdx = (opts.parentPhaseIdx + 1) * 1000 + (childOrdinal += 1);
    return runPhase(child, input, {
      runDir: opts.runDir,
      runId: opts.runId,
      writerId: opts.writerId,
      phaseIdx: childIdx,
    });
  };
}

// ----------------------------------------------------------------------------
// Phase 4 — budget helpers
// ----------------------------------------------------------------------------

/** Sum every `phase.cost` event across the WHOLE run (not just the current
 *  phaseIdx). The budget cap is run-wide; sub-phase costs and prior-phase
 *  costs both count against `perRunUSD`. */
function sumRunCost(events: RunEvent[]): number {
  let total = 0;
  for (const ev of events) {
    if (ev.event === 'phase.cost') total += ev.costUSD;
  }
  return total;
}

/** Default interactive confirm prompt used when no `confirmBudgetPause`
 *  override is supplied. Uses node:readline so the runner doesn't pull in
 *  a dependency just for prompting. */
async function defaultConfirmBudgetPause(check: BudgetCheck): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const message =
      `Budget warning: ${check.reason}\n` +
      `  phase: ${check.phase} (idx ${check.phaseIdx})\n` +
      `  actualSoFar: $${check.actualSoFar.toFixed(2)}\n` +
      `  reserveApplied: $${check.reserveApplied.toFixed(2)}\n` +
      `  capRemaining: $${check.capRemaining.toFixed(2)}\n` +
      `Continue and accept the overage? [y/N] `;
    const answer: string = await new Promise(resolve => rl.question(message, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
