// src/core/run-state/budget.ts
//
// v6 Phase 4 — budget enforcement policy.
//
// Pure data + a pure decision function. No IO, no globals, no side effects.
// `checkPhaseBudget` is the authoritative answer to "may this phase run?"
// — `runPhase` consumes the result, emits a `budget.check` event with the
// full payload, and throws `budget_exceeded` on hard-fail.
//
// Two-layer policy per spec (Codex CRITICAL #3 fold-in — estimates can fail
// open, the runtime guard MUST run independently):
//
//   - Layer 1 (advisory)  — only fires when the phase declares
//     `estimateCost`. Compares `actualSoFar + estimate.high` against
//     `perRunUSD`. Pause-and-prompt (interactive) or hard-fail (CI mode)
//     if it would exceed.
//   - Layer 2 (mandatory) — ALWAYS runs. Compares `actualSoFar +
//     conservativePhaseReserveUSD` against `perRunUSD`. Phases without
//     estimates therefore still trigger budget gates. Default reserve is
//     $5 (overridable in config).
//   - `perPhaseUSD` gate — if set AND the larger of the per-phase estimate
//     or reserve would push this phase's cost over the per-phase cap,
//     applies the same pause/hard-fail rule.
//
// Spec: docs/specs/v6-run-state-engine.md "Budget enforcement".

/** Default Layer 2 reserve when none is configured. Conservative — phases
 *  without an `estimateCost` are assumed to consume at least this much,
 *  which keeps the cap from "failing open" the moment a phase forgets to
 *  declare its cost shape. */
export const DEFAULT_CONSERVATIVE_PHASE_RESERVE_USD = 5;

export interface BudgetConfig {
  /** Total run cap (USD). Hard stop. Required — phases that don't want
   *  budget enforcement should not pass a `BudgetConfig` at all. */
  perRunUSD: number;
  /** Per-phase cap (USD). Phases that haven't declared `estimateCost`
   *  still pay the conservativePhaseReserve under Layer 2. Optional. */
  perPhaseUSD?: number;
  /** Bounded recursion for council synthesizer. Wired in
   *  `src/core/council/runner.ts`; no effect inside `runPhase`. */
  councilMaxRecursionDepth?: number;
  /** Bounded autopilot self-eat rounds (per spec). Reserved field —
   *  consumed by the autopilot orchestrator, not the runner. */
  bgAutopilotMaxRoundsPerSelfEat?: number;
  /** Used by Layer 2 (mandatory runtime guard) when a phase has no
   *  `estimateCost` — represents the "we don't know how big this gets,
   *  reserve at least this much from the cap" floor. Defaults to
   *  `DEFAULT_CONSERVATIVE_PHASE_RESERVE_USD` when omitted. */
  conservativePhaseReserveUSD?: number;
  /** v6.2.0 — budget scope. `'phase'` (default) keeps the legacy
   *  per-phase semantics where each `runPhase` invocation reasons against
   *  its own phase budget (back-compat for single-phase wrappers like
   *  `runPhaseWithLifecycle`). `'run'` is the orchestrator's
   *  cross-phase mode: the actualSoFar reservoir already sums every
   *  prior `phase.cost` event in the run, so `perRunUSD` is policed
   *  monotonically against the WHOLE pipeline's spend.
   *
   *  In practice the policy math is identical between the two scopes —
   *  Layer 1 + Layer 2 both consume `actualSoFarUSD` regardless. The
   *  scope flag exists so the `budget.check` event tells observers
   *  which mode produced the decision (so a CI dashboard can attribute
   *  a reject to "run scope" vs "single-phase scope") and so future
   *  policy changes (e.g. divergent perPhase reserves under run scope)
   *  have a place to land without an event-shape break.
   *
   *  Per spec docs/specs/v6.2-multi-phase-orchestrator.md "Budget
   *  enforcement": `checkPhaseBudget` gains `scope: 'phase' | 'run'`
   *  (default 'phase' for back-compat). Orchestrator passes
   *  `scope: 'run'`; per-phase callers keep the default. */
  scope?: 'phase' | 'run';
}

/** The decision the runner consumes. Mirrors the `budget.check` event
 *  payload one-to-one so wiring is trivial. */
export interface BudgetCheck {
  decision: 'proceed' | 'pause' | 'hard-fail';
  phase: string;
  phaseIdx: number;
  /** `estimate.high` from the phase's `estimateCost` if it returned a
   *  value; null when the phase doesn't implement estimateCost. */
  estimatedHigh: number | null;
  actualSoFar: number;
  /** The reserve the policy deducted against `perRunUSD` for this phase
   *  (the larger of `estimate.high` and `conservativePhaseReserveUSD`). */
  reserveApplied: number;
  /** USD remaining under `perRunUSD` after `actualSoFar` + the larger of
   *  `estimatedHigh` and `reserveApplied`. May be negative on hard-fail. */
  capRemaining: number;
  reason: string;
  /** v6.2.0 — which scope produced the decision. Echoes `BudgetConfig.scope`
   *  back into the `budget.check` event so observers can attribute
   *  cross-phase rejections to the orchestrator vs single-phase wrappers
   *  passing the legacy default. */
  scope: 'phase' | 'run';
}

export interface CheckPhaseBudgetOpts {
  budget: BudgetConfig;
  phaseName: string;
  phaseIdx: number;
  /** What `RunPhase.estimateCost(input)` returned, or null if absent. */
  estimatedCost: { lowUSD: number; highUSD: number } | null;
  /** Sum of every prior `phase.cost` event in the run, in USD. */
  actualSoFarUSD: number;
  /** When true, a `pause` decision becomes `hard-fail` (CI / `--json`
   *  mode can't prompt for human approval). */
  nonInteractive: boolean;
}

/** Policy decision for a single about-to-run phase. Pure — no IO. The
 *  caller (`runPhase`) is responsible for emitting the `budget.check`
 *  event with this payload and acting on the decision. */
export function checkPhaseBudget(opts: CheckPhaseBudgetOpts): BudgetCheck {
  const {
    budget,
    phaseName,
    phaseIdx,
    estimatedCost,
    actualSoFarUSD,
    nonInteractive,
  } = opts;

  // v6.2.0 — `'phase'` (default for back-compat) vs `'run'` (orchestrator).
  // The math is intentionally identical between the two; `actualSoFarUSD`
  // is already the cross-phase sum produced by `sumRunCost` in
  // phase-runner.ts. The flag exists so the `budget.check` event tells
  // observers which scope generated the decision and so future policy
  // tweaks (e.g. divergent perPhase reserves under run scope) have a
  // place to land without an event-shape break.
  const scope: 'phase' | 'run' = budget.scope ?? 'phase';

  const reserveFloor =
    typeof budget.conservativePhaseReserveUSD === 'number'
      ? budget.conservativePhaseReserveUSD
      : DEFAULT_CONSERVATIVE_PHASE_RESERVE_USD;

  // The reserve actually deducted is the larger of "what the phase says
  // it will cost (high end)" and "the conservative floor we always apply".
  // This is the core of Codex CRITICAL #3 — even if estimateCost is
  // present and tiny, the floor still applies, and even if estimateCost
  // is absent, the floor still applies.
  const estimatedHigh = estimatedCost?.highUSD ?? null;
  const reserveApplied = Math.max(estimatedHigh ?? 0, reserveFloor);

  const projected = actualSoFarUSD + reserveApplied;
  const capRemaining = budget.perRunUSD - projected;

  // Layer 1 — ADVISORY using the explicit estimate. Runs FIRST so a precise
  // estimate produces a precise reason ("estimate would exceed cap") instead
  // of falling through to Layer 2's conservative-floor wording. Only fires
  // when an estimate is present AND would push us past perRunUSD on its own.
  // (Bugbot LOW on PR #89 caught the prior ordering, where Layer 2 always
  // ran first and Layer 1 was provably unreachable since `reserveApplied =
  // max(estimatedHigh, floor) >= estimatedHigh`.)
  if (estimatedHigh !== null && actualSoFarUSD + estimatedHigh > budget.perRunUSD) {
    const decision = nonInteractive ? 'hard-fail' : 'pause';
    return {
      decision,
      phase: phaseName,
      phaseIdx,
      estimatedHigh,
      actualSoFar: actualSoFarUSD,
      reserveApplied,
      capRemaining: budget.perRunUSD - (actualSoFarUSD + estimatedHigh),
      reason:
        `advisory estimate would exceed run cap — actual ` +
        `$${fmtUSD(actualSoFarUSD)} + estimate.high ` +
        `$${fmtUSD(estimatedHigh)} > perRunUSD $${fmtUSD(budget.perRunUSD)}`,
      scope,
    };
  }

  // Layer 2 — MANDATORY floor against perRunUSD. Catches the case where the
  // estimate is missing (Layer 1 didn't fire) OR present-but-tiny (estimate
  // alone fits, but the conservative reserve floor pushes over). This is the
  // safety net that prevents phases without `estimateCost` from sneaking
  // past the cap.
  if (projected > budget.perRunUSD) {
    const decision = nonInteractive ? 'hard-fail' : 'pause';
    return {
      decision,
      phase: phaseName,
      phaseIdx,
      estimatedHigh,
      actualSoFar: actualSoFarUSD,
      reserveApplied,
      capRemaining,
      reason:
        `run cap exceeded — actual $${fmtUSD(actualSoFarUSD)} + reserve ` +
        `$${fmtUSD(reserveApplied)} = $${fmtUSD(projected)} > perRunUSD ` +
        `$${fmtUSD(budget.perRunUSD)}`,
      scope,
    };
  }

  // perPhaseUSD gate — independent of the run cap. Applies the same
  // reserve logic but compares against the per-phase cap.
  if (typeof budget.perPhaseUSD === 'number' && reserveApplied > budget.perPhaseUSD) {
    const decision = nonInteractive ? 'hard-fail' : 'pause';
    return {
      decision,
      phase: phaseName,
      phaseIdx,
      estimatedHigh,
      actualSoFar: actualSoFarUSD,
      reserveApplied,
      capRemaining,
      reason:
        `per-phase cap exceeded — reserve $${fmtUSD(reserveApplied)} > ` +
        `perPhaseUSD $${fmtUSD(budget.perPhaseUSD)}`,
      scope,
    };
  }

  return {
    decision: 'proceed',
    phase: phaseName,
    phaseIdx,
    estimatedHigh,
    actualSoFar: actualSoFarUSD,
    reserveApplied,
    capRemaining,
    reason: estimatedHigh !== null
      ? `within budget — projected $${fmtUSD(projected)} of $${fmtUSD(budget.perRunUSD)}`
      : `within budget (no estimate, applied $${fmtUSD(reserveApplied)} ` +
        `reserve floor) — projected $${fmtUSD(projected)} of ` +
        `$${fmtUSD(budget.perRunUSD)}`,
    scope,
  };
}

/** Format a USD amount with 2 decimal places for human-readable reasons.
 *  Kept local — the run-state module doesn't have a shared formatter and
 *  budget reasons are the only consumer. */
function fmtUSD(n: number): string {
  // toFixed(2) returns "0.00" for 0; we keep the trailing zeros so the
  // reason strings line up visually in CLI output.
  return n.toFixed(2);
}
