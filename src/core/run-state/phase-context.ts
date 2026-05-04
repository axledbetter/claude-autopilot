// src/core/run-state/phase-context.ts
//
// Internal helpers used by `runPhase` to assemble the `PhaseContext` passed
// into `RunPhase.run`. Kept separate from the public surface in
// phase-runner.ts so tests can probe the cost / externalRef plumbing without
// going through the full lifecycle wrapper.
//
// The functions here only KNOW about Phase 1's appendEvent; they don't
// orchestrate phase.start / phase.success / phase.failed (that's
// phase-runner.ts). They are essentially the "ctx surface" the running phase
// uses to write costs and external references during the run.
//
// Spec: docs/specs/v6-run-state-engine.md "Phase contract", "Idempotency
// rules + external operation ledger".

import { appendEvent } from './events.ts';
import type {
  ExternalRef,
  RunEvent,
  WriterId,
} from './types.ts';

/** What every running phase receives. Public — re-exported from
 *  phase-runner.ts. */
export interface PhaseContext {
  runDir: string;
  runId: string;
  phaseIdx: number;
  writerId: WriterId;
  /** Append a `phase.cost` event during the run. Adapters / SDK calls
   *  should call this whenever a cost ledger entry would be written. */
  emitCost(entry: PhaseCostInput): void;
  /** Persist an externalRef so resume decisions can read back from the run.
   *  Phase 6 will wire `onResume` to consult these; Phase 2 just records. */
  emitExternalRef(ref: Omit<ExternalRef, 'observedAt'>): void;
  /** Inject a child sub-phase. Records as a separate phase.start under the
   *  parent. Useful for things like council (which has N inner consults).
   *  Optional in Phase 2 — see phase-runner.ts. */
  subPhase?<SI, SO>(
    child: import('./phase-runner.ts').RunPhase<SI, SO>,
    input: SI,
  ): Promise<SO>;
}

export interface PhaseCostInput {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

/** Inputs the runner needs to build a context. `subPhase` is optional —
 *  phase-runner.ts wires it when nested sub-phases are supported. */
export interface BuildPhaseContextInput {
  runDir: string;
  runId: string;
  phaseName: string;
  phaseIdx: number;
  writerId: WriterId;
  /** Optional sub-phase factory; pass-through to the returned context. */
  subPhase?: PhaseContext['subPhase'];
}

/** Construct a PhaseContext bound to a specific (runDir, runId, phaseIdx,
 *  phaseName, writerId). The returned object is a thin facade over
 *  `appendEvent`; it is a pure function in the no-IO sense — actual disk IO
 *  happens lazily on each emit call. */
export function buildPhaseContext(input: BuildPhaseContextInput): PhaseContext {
  const { runDir, runId, phaseName, phaseIdx, writerId, subPhase } = input;

  const emitCost = (entry: PhaseCostInput): void => {
    appendEvent(
      runDir,
      {
        event: 'phase.cost',
        phase: phaseName,
        phaseIdx,
        provider: entry.provider,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        costUSD: entry.costUSD,
      },
      { writerId, runId },
    );
  };

  const emitExternalRef = (ref: Omit<ExternalRef, 'observedAt'>): void => {
    const fullRef: ExternalRef = {
      ...ref,
      observedAt: new Date().toISOString(),
    };
    appendEvent(
      runDir,
      {
        event: 'phase.externalRef',
        phase: phaseName,
        phaseIdx,
        ref: fullRef,
      },
      { writerId, runId },
    );
  };

  const ctx: PhaseContext = {
    runDir,
    runId,
    phaseIdx,
    writerId,
    emitCost,
    emitExternalRef,
  };
  if (subPhase) ctx.subPhase = subPhase;
  return ctx;
}

/** Helper for phase-runner.ts: aggregate every phase.cost event for a given
 *  phase index from an in-memory event stream. Returned in USD. */
export function sumPhaseCost(events: RunEvent[], phaseIdx: number): number {
  let total = 0;
  for (const ev of events) {
    if (ev.event === 'phase.cost' && ev.phaseIdx === phaseIdx) total += ev.costUSD;
  }
  return total;
}

/** Helper for phase-runner.ts: collect every external ref recorded for a
 *  given phase index from an in-memory event stream. Dedup by kind+id. */
export function collectExternalRefs(
  events: RunEvent[],
  phaseIdx: number,
): ExternalRef[] {
  const out: ExternalRef[] = [];
  for (const ev of events) {
    if (ev.event === 'phase.externalRef' && ev.phaseIdx === phaseIdx) {
      const dup = out.find(r => r.kind === ev.ref.kind && r.id === ev.ref.id);
      if (!dup) out.push(ev.ref);
    }
  }
  return out;
}

/** Helper: count successful prior attempts of a given phase (matched by
 *  phaseIdx). Lets the runner detect "this phase already succeeded —
 *  short-circuit on idempotent replay". */
export function countPhaseSuccesses(
  events: RunEvent[],
  phaseIdx: number,
): number {
  let n = 0;
  for (const ev of events) {
    if (ev.event === 'phase.success' && ev.phaseIdx === phaseIdx) n += 1;
  }
  return n;
}

/** Helper: count attempts of a given phase (number of phase.start events
 *  for that phaseIdx). The next attempt's `attempt` field is `count + 1`. */
export function countPhaseAttempts(
  events: RunEvent[],
  phaseIdx: number,
): number {
  let n = 0;
  for (const ev of events) {
    if (ev.event === 'phase.start' && ev.phaseIdx === phaseIdx) n += 1;
  }
  return n;
}
