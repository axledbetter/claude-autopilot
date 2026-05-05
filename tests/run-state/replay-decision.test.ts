import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideReplay,
  type ReplayDecisionInput,
} from '../../src/core/run-state/replay-decision.ts';
import type { ExternalRef } from '../../src/core/run-state/types.ts';
import type { ReadbackResult } from '../../src/core/run-state/provider-readback.ts';

function baseInput(overrides: Partial<ReplayDecisionInput> = {}): ReplayDecisionInput {
  return {
    phaseName: 'pr',
    hasPriorSuccess: false,
    idempotent: false,
    hasSideEffects: false,
    externalRefs: [],
    readbacks: [],
    forceReplay: false,
    ...overrides,
  };
}

const githubPrRef: ExternalRef = {
  kind: 'github-pr',
  id: '99',
  provider: 'github',
  observedAt: '2026-05-04T00:00:00Z',
};

const validReadback: ReadbackResult = {
  refKind: 'github-pr',
  refId: '99',
  existsOnPlatform: true,
  currentState: 'open',
};

const closedReadback: ReadbackResult = {
  refKind: 'github-pr',
  refId: '99',
  existsOnPlatform: true,
  currentState: 'closed',
};

const unknownReadback: ReadbackResult = {
  refKind: 'github-pr',
  refId: '99',
  existsOnPlatform: false,
  currentState: 'unknown',
};

describe('decideReplay — matrix per spec idempotency table', () => {
  it('no prior success → retry', () => {
    const d = decideReplay(baseInput({ hasPriorSuccess: false }));
    assert.equal(d.decision, 'retry');
    assert.match(d.reason, /first attempt/);
  });

  it('no prior success + side-effects + refs → still retry (refs from earlier failed attempt are not authoritative)', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: false,
      hasSideEffects: true,
      externalRefs: [githubPrRef],
    }));
    assert.equal(d.decision, 'retry');
  });

  it('prior success + idempotent → skip-already-applied', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: true,
    }));
    assert.equal(d.decision, 'skip-already-applied');
    assert.match(d.reason, /idempotent/);
  });

  it('prior success + idempotent + side-effects → skip-already-applied (idempotent wins)', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: true,
      hasSideEffects: true,
    }));
    assert.equal(d.decision, 'skip-already-applied');
  });

  it('prior success + no side-effects → skip-already-applied (nothing to verify)', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: false,
    }));
    assert.equal(d.decision, 'skip-already-applied');
    assert.match(d.reason, /no side effects/);
  });

  it('prior success + side-effects + no refs → needs-human', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: true,
      externalRefs: [],
    }));
    assert.equal(d.decision, 'needs-human');
    assert.match(d.reason, /no externalRefs/);
  });

  it('prior success + side-effects + refs but no readbacks (lookup mode) → needs-human', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: true,
      externalRefs: [githubPrRef],
      readbacks: [],
    }));
    assert.equal(d.decision, 'needs-human');
    assert.match(d.reason, /no live readback/);
  });

  it('prior success + side-effects + refs ALL valid → skip-already-applied', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: true,
      externalRefs: [githubPrRef],
      readbacks: [validReadback],
    }));
    assert.equal(d.decision, 'skip-already-applied');
    assert.equal(d.readbacksConsulted.length, 1);
  });

  it('prior success + side-effects + refs but readback shows CLOSED → needs-human', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: true,
      externalRefs: [githubPrRef],
      readbacks: [closedReadback],
    }));
    assert.equal(d.decision, 'needs-human');
    assert.match(d.reason, /stale or missing/);
  });

  it('prior success + side-effects + refs but readback UNKNOWN → needs-human (fail closed)', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: true,
      externalRefs: [githubPrRef],
      readbacks: [unknownReadback],
    }));
    assert.equal(d.decision, 'needs-human');
  });

  it('prior success + side-effects + multiple refs, mix of valid & stale → needs-human, names the stale refs', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: true,
      externalRefs: [
        githubPrRef,
        { ...githubPrRef, id: '100' },
      ],
      readbacks: [
        validReadback,
        { ...closedReadback, refId: '100' },
      ],
    }));
    assert.equal(d.decision, 'needs-human');
    assert.match(d.reason, /github-pr=100/);
  });

  it('forceReplay overrides any decision → retry', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: true,
      externalRefs: [githubPrRef],
      readbacks: [closedReadback],
      forceReplay: true,
    }));
    assert.equal(d.decision, 'retry');
    assert.match(d.reason, /forceReplay override/);
  });

  it('forceReplay overrides idempotent skip → still retry', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: true,
      forceReplay: true,
    }));
    assert.equal(d.decision, 'retry');
  });

  it('decision echoes refsConsulted and readbacksConsulted for triage', () => {
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: true,
      externalRefs: [githubPrRef],
      readbacks: [validReadback],
    }));
    assert.deepEqual(d.refsConsulted, [githubPrRef]);
    assert.deepEqual(d.readbacksConsulted, [validReadback]);
  });

  it('merged PR is treated as live (skip-already-applied)', () => {
    const merged: ReadbackResult = {
      refKind: 'github-pr',
      refId: '99',
      existsOnPlatform: true,
      currentState: 'merged',
    };
    const d = decideReplay(baseInput({
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: true,
      externalRefs: [githubPrRef],
      readbacks: [merged],
    }));
    assert.equal(d.decision, 'skip-already-applied');
  });

  it('rolled-back deploy is stale → needs-human', () => {
    const ref: ExternalRef = {
      kind: 'deploy',
      id: 'dpl_xyz',
      provider: 'vercel',
      observedAt: '2026-05-04T00:00:00Z',
    };
    const rb: ReadbackResult = {
      refKind: 'deploy',
      refId: 'dpl_xyz',
      existsOnPlatform: true,
      currentState: 'rolled-back',
    };
    const d = decideReplay(baseInput({
      phaseName: 'deploy',
      hasPriorSuccess: true,
      idempotent: false,
      hasSideEffects: true,
      externalRefs: [ref],
      readbacks: [rb],
    }));
    assert.equal(d.decision, 'needs-human');
    assert.match(d.reason, /rolled-back/);
  });
});
