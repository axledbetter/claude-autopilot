import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPhaseBudget,
  DEFAULT_CONSERVATIVE_PHASE_RESERVE_USD,
  type BudgetConfig,
} from '../../src/core/run-state/budget.ts';

// ---------------------------------------------------------------------------
// Layer 1 — advisory (estimateCost present)
// ---------------------------------------------------------------------------

describe('checkPhaseBudget — Layer 1 (advisory, estimate present)', () => {
  it('proceeds when estimate fits comfortably under perRunUSD', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 25 },
      phaseName: 'plan',
      phaseIdx: 1,
      estimatedCost: { lowUSD: 0.5, highUSD: 2 },
      actualSoFarUSD: 1,
      nonInteractive: false,
    });
    assert.equal(result.decision, 'proceed');
    assert.equal(result.estimatedHigh, 2);
    assert.equal(result.actualSoFar, 1);
    // Reserve applied is the larger of estimate.high (2) and the floor (5).
    assert.equal(result.reserveApplied, DEFAULT_CONSERVATIVE_PHASE_RESERVE_USD);
    assert.equal(result.phase, 'plan');
    assert.equal(result.phaseIdx, 1);
  });

  it('returns reserveApplied = estimate.high when estimate exceeds the floor', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 100 },
      phaseName: 'big',
      phaseIdx: 0,
      estimatedCost: { lowUSD: 5, highUSD: 12 },
      actualSoFarUSD: 0,
      nonInteractive: false,
    });
    assert.equal(result.decision, 'proceed');
    assert.equal(result.reserveApplied, 12);
  });

  it('pauses when estimate would push run over perRunUSD (interactive)', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 10 },
      phaseName: 'pricey',
      phaseIdx: 2,
      estimatedCost: { lowUSD: 4, highUSD: 8 },
      actualSoFarUSD: 5,
      nonInteractive: false,
    });
    assert.equal(result.decision, 'pause');
    assert.ok(result.capRemaining < 0, 'capRemaining must reflect the overage');
    assert.match(result.reason, /run cap exceeded|advisory estimate/);
  });

  it('hard-fails (not pauses) when estimate would exceed cap in non-interactive mode', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 10 },
      phaseName: 'pricey',
      phaseIdx: 2,
      estimatedCost: { lowUSD: 4, highUSD: 8 },
      actualSoFarUSD: 5,
      nonInteractive: true,
    });
    assert.equal(result.decision, 'hard-fail');
  });

  it('Layer 1 reason fires BEFORE Layer 2 when both would catch (Bugbot LOW, PR #89)', () => {
    // Regression: prior implementation ran Layer 2 first, and because
    // `reserveApplied = max(estimatedHigh, floor) >= estimatedHigh`, Layer 1
    // was provably unreachable. Both layers would have the same trigger and
    // Layer 2 always won. Now Layer 1 runs first so a precise estimate
    // produces the precise "advisory estimate would exceed" reason instead
    // of the conservative "reserve" wording.
    //
    // estimatedHigh=8 > floor=5; both Layer 1 (5+8=13 > 10) and Layer 2
    // (5+max(8,5)=13 > 10) would fire. Assert the Layer 1 reason wins.
    const result = checkPhaseBudget({
      budget: { perRunUSD: 10, conservativePhaseReserveUSD: 5 },
      phaseName: 'pricey',
      phaseIdx: 2,
      estimatedCost: { lowUSD: 4, highUSD: 8 },
      actualSoFarUSD: 5,
      nonInteractive: false,
    });
    assert.equal(result.decision, 'pause');
    assert.match(result.reason, /advisory estimate/, 'expected Layer 1 wording');
    assert.ok(!/reserve \$/.test(result.reason), 'must not show Layer 2 wording when Layer 1 caught it');
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — mandatory floor (estimate absent)
// ---------------------------------------------------------------------------

describe('checkPhaseBudget — Layer 2 (mandatory, no estimate)', () => {
  it('applies the conservative reserve floor when estimateCost is null', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 25 },
      phaseName: 'unknown',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 0,
      nonInteractive: false,
    });
    assert.equal(result.decision, 'proceed');
    assert.equal(result.estimatedHigh, null);
    assert.equal(result.reserveApplied, DEFAULT_CONSERVATIVE_PHASE_RESERVE_USD);
    assert.match(result.reason, /no estimate.*reserve floor/);
  });

  it('respects an explicit conservativePhaseReserveUSD override', () => {
    const budget: BudgetConfig = { perRunUSD: 100, conservativePhaseReserveUSD: 25 };
    const result = checkPhaseBudget({
      budget,
      phaseName: 'unknown',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 0,
      nonInteractive: false,
    });
    assert.equal(result.reserveApplied, 25);
  });

  it('hard-fails when reserve floor alone would exceed perRunUSD (CI mode)', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 6 },
      phaseName: 'unknown',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 2,
      nonInteractive: true,
    });
    // 2 + 5 (floor) = 7 > 6 → hard-fail in CI
    assert.equal(result.decision, 'hard-fail');
    assert.match(result.reason, /run cap exceeded/);
    assert.equal(result.estimatedHigh, null);
    assert.equal(result.reserveApplied, DEFAULT_CONSERVATIVE_PHASE_RESERVE_USD);
  });

  it('Codex CRITICAL #3 — Layer 2 fires even when estimate.high is tiny', () => {
    // Phase declares an estimate of $0.10 high, but actualSoFar is already
    // close to the cap. The conservative floor MUST still apply, otherwise
    // an under-estimating phase silently bypasses budget enforcement.
    const result = checkPhaseBudget({
      budget: { perRunUSD: 10 },
      phaseName: 'liar',
      phaseIdx: 0,
      estimatedCost: { lowUSD: 0.05, highUSD: 0.10 },
      actualSoFarUSD: 6,
      nonInteractive: true,
    });
    // 6 + max(0.10, 5) = 11 > 10 → hard-fail.
    assert.equal(result.decision, 'hard-fail');
    assert.equal(result.reserveApplied, DEFAULT_CONSERVATIVE_PHASE_RESERVE_USD);
    assert.match(result.reason, /run cap exceeded/);
  });
});

// ---------------------------------------------------------------------------
// perPhaseUSD gate
// ---------------------------------------------------------------------------

describe('checkPhaseBudget — perPhaseUSD gate', () => {
  it('proceeds when reserveApplied stays within perPhaseUSD', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 100, perPhaseUSD: 10 },
      phaseName: 'small',
      phaseIdx: 0,
      estimatedCost: { lowUSD: 1, highUSD: 3 },
      actualSoFarUSD: 0,
      nonInteractive: false,
    });
    assert.equal(result.decision, 'proceed');
  });

  it('hard-fails when reserve floor exceeds per-phase cap (CI mode)', () => {
    // Per-phase cap of $2 — even an unestimated phase reserves $5 floor,
    // which exceeds the cap.
    const result = checkPhaseBudget({
      budget: { perRunUSD: 100, perPhaseUSD: 2 },
      phaseName: 'small-cap',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 0,
      nonInteractive: true,
    });
    assert.equal(result.decision, 'hard-fail');
    assert.match(result.reason, /per-phase cap exceeded/);
  });

  it('pauses (interactive) when estimate exceeds per-phase cap', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 100, perPhaseUSD: 5 },
      phaseName: 'large',
      phaseIdx: 0,
      estimatedCost: { lowUSD: 4, highUSD: 8 },
      actualSoFarUSD: 0,
      nonInteractive: false,
    });
    assert.equal(result.decision, 'pause');
    assert.match(result.reason, /per-phase cap exceeded/);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — exact boundaries
// ---------------------------------------------------------------------------

describe('checkPhaseBudget — edge cases', () => {
  it('proceeds when projected exactly equals perRunUSD (boundary)', () => {
    // 5 + max(2, 5) = 10, which equals perRunUSD = 10 → still under cap.
    const result = checkPhaseBudget({
      budget: { perRunUSD: 10 },
      phaseName: 'boundary',
      phaseIdx: 0,
      estimatedCost: { lowUSD: 1, highUSD: 2 },
      actualSoFarUSD: 5,
      nonInteractive: false,
    });
    assert.equal(result.decision, 'proceed');
    assert.equal(result.capRemaining, 0);
  });

  it('records the actual capRemaining as negative on overage', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 5 },
      phaseName: 'overage',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 3,
      nonInteractive: true,
    });
    // 3 + 5 = 8, capRemaining = -3
    assert.equal(result.decision, 'hard-fail');
    assert.equal(result.capRemaining, -3);
  });

  it('handles actualSoFarUSD = 0 and budget = $0 (degenerate but well-defined)', () => {
    // perRunUSD: 0 means "no spend allowed at all" — even the floor is over.
    const result = checkPhaseBudget({
      budget: { perRunUSD: 0 },
      phaseName: 'starved',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 0,
      nonInteractive: true,
    });
    assert.equal(result.decision, 'hard-fail');
  });

  it('explicit conservativePhaseReserveUSD = 0 disables the Layer 2 floor', () => {
    // Caller can opt out of the floor by setting it to 0. Then a phase
    // without estimateCost reserves nothing — Layer 2 collapses to a
    // "0 reserved" check that always proceeds.
    const result = checkPhaseBudget({
      budget: { perRunUSD: 1, conservativePhaseReserveUSD: 0 },
      phaseName: 'no-floor',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 0.5,
      nonInteractive: true,
    });
    assert.equal(result.decision, 'proceed');
    assert.equal(result.reserveApplied, 0);
  });
});

// ---------------------------------------------------------------------------
// v6.2.0 — run-scope budget (per spec WARNING #2)
// ---------------------------------------------------------------------------

describe('checkPhaseBudget — scope: run (v6.2.0)', () => {
  it('default scope is "phase" (back-compat — omitting the field)', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 100 },
      phaseName: 'phase0',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 0,
      nonInteractive: false,
    });
    assert.equal(result.scope, 'phase');
  });

  it('scope: "run" passes through to the BudgetCheck payload', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 100, scope: 'run' },
      phaseName: 'phase0',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 0,
      nonInteractive: false,
    });
    assert.equal(result.scope, 'run');
    assert.equal(result.decision, 'proceed');
  });

  it('scope: "run" — accumulated spend across phases trips the cap on a later phase', () => {
    // Simulate the orchestrator running 3 phases. The 3rd phase sees an
    // actualSoFarUSD that aggregates phases 0 + 1 + sub-phases. With a
    // $10 cap and $9 already burned + the $5 floor, Layer 2 trips.
    const result = checkPhaseBudget({
      budget: { perRunUSD: 10, scope: 'run' },
      phaseName: 'phase2',
      phaseIdx: 2,
      estimatedCost: null,
      actualSoFarUSD: 9, // sum of every prior phase.cost across the run
      nonInteractive: true,
    });
    assert.equal(result.decision, 'hard-fail');
    assert.equal(result.scope, 'run');
    assert.match(result.reason, /run cap exceeded/);
  });

  it('scope: "run" — Layer 1 advisory still fires when the estimate alone exceeds the cap', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 10, scope: 'run' },
      phaseName: 'pricey',
      phaseIdx: 1,
      estimatedCost: { lowUSD: 1, highUSD: 12 },
      actualSoFarUSD: 0,
      nonInteractive: true,
    });
    assert.equal(result.decision, 'hard-fail');
    assert.equal(result.scope, 'run');
    assert.match(result.reason, /advisory estimate/);
  });

  it('scope: "run" — proceeds when accumulated spend + reserve fits', () => {
    const result = checkPhaseBudget({
      budget: { perRunUSD: 25, scope: 'run' },
      phaseName: 'phase3',
      phaseIdx: 3,
      estimatedCost: { lowUSD: 0.5, highUSD: 2 },
      actualSoFarUSD: 10, // 3 phases @ ~$3.33 already
      nonInteractive: false,
    });
    assert.equal(result.decision, 'proceed');
    assert.equal(result.scope, 'run');
    assert.equal(result.actualSoFar, 10);
    // Layer 2 reserve floor (default $5) + actualSoFar = $15 < $25 cap.
    assert.ok(result.capRemaining > 0);
  });

  it('scope: "run" — math is identical between phase and run scopes given the same actualSoFar', () => {
    // The scope flag is a label; the policy math is unchanged. Same
    // inputs in either scope must produce the same decision + reasons.
    // (This is a regression guard so a future divergent policy doesn't
    // silently break orchestrator parity.)
    const phaseResult = checkPhaseBudget({
      budget: { perRunUSD: 10, scope: 'phase' },
      phaseName: 'p',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 6,
      nonInteractive: true,
    });
    const runResult = checkPhaseBudget({
      budget: { perRunUSD: 10, scope: 'run' },
      phaseName: 'p',
      phaseIdx: 0,
      estimatedCost: null,
      actualSoFarUSD: 6,
      nonInteractive: true,
    });
    assert.equal(phaseResult.decision, runResult.decision);
    assert.equal(phaseResult.reason, runResult.reason);
    assert.equal(phaseResult.capRemaining, runResult.capRemaining);
    assert.equal(phaseResult.scope, 'phase');
    assert.equal(runResult.scope, 'run');
  });
});
