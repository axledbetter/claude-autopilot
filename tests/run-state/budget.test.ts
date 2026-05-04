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
