import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildPhaseContext,
  collectExternalRefs,
  countPhaseAttempts,
  countPhaseSuccesses,
  sumPhaseCost,
} from '../../src/core/run-state/phase-context.ts';
import { appendEvent, readEvents } from '../../src/core/run-state/events.ts';
import { makeWriterId } from '../../src/core/run-state/lock.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-phase-ctx-'));
}

const writerId = makeWriterId();

describe('buildPhaseContext.emitCost', () => {
  it('appends phase.cost events with monotonic seq across multiple calls', () => {
    const dir = tmp();
    const runId = 'TESTRUN';
    appendEvent(dir, { event: 'run.start', phases: ['plan'] }, { writerId, runId });
    const ctx = buildPhaseContext({
      runDir: dir, runId, phaseName: 'plan', phaseIdx: 0, writerId,
    });
    ctx.emitCost({ provider: 'anthropic', inputTokens: 10, outputTokens: 20, costUSD: 0.01 });
    ctx.emitCost({ provider: 'anthropic', inputTokens: 30, outputTokens: 40, costUSD: 0.02 });
    ctx.emitCost({ provider: 'openai', inputTokens: 5, outputTokens: 5, costUSD: 0.05 });
    const { events } = readEvents(dir);
    const seqs = events.filter(e => e.event === 'phase.cost').map(e => e.seq);
    assert.equal(seqs.length, 3);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok((seqs[i] as number) > (seqs[i - 1] as number), 'seq must be strictly increasing');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildPhaseContext.emitExternalRef', () => {
  it('appends phase.externalRef with observedAt stamped', () => {
    const dir = tmp();
    const runId = 'TESTRUN';
    appendEvent(dir, { event: 'run.start', phases: ['pr'] }, { writerId, runId });
    const ctx = buildPhaseContext({
      runDir: dir, runId, phaseName: 'pr', phaseIdx: 0, writerId,
    });
    ctx.emitExternalRef({ kind: 'github-pr', id: '42', provider: 'github' });
    const { events } = readEvents(dir);
    const refEv = events.find(e => e.event === 'phase.externalRef') as
      | { ref: { kind: string; id: string; observedAt?: string } }
      | undefined;
    assert.ok(refEv, 'phase.externalRef event missing');
    assert.equal(refEv?.ref.kind, 'github-pr');
    assert.equal(refEv?.ref.id, '42');
    assert.ok(refEv?.ref.observedAt, 'observedAt must be filled in');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('phase-context — pure helpers', () => {
  function build(): { events: Parameters<typeof sumPhaseCost>[0]; runDir: string } {
    const runDir = tmp();
    const runId = 'R';
    appendEvent(runDir, { event: 'run.start', phases: ['a', 'b'] }, { writerId, runId });
    appendEvent(runDir, {
      event: 'phase.start', phase: 'a', phaseIdx: 0,
      idempotent: true, hasSideEffects: false, attempt: 1,
    }, { writerId, runId });
    appendEvent(runDir, {
      event: 'phase.cost', phase: 'a', phaseIdx: 0,
      provider: 'x', inputTokens: 1, outputTokens: 1, costUSD: 0.10,
    }, { writerId, runId });
    appendEvent(runDir, {
      event: 'phase.cost', phase: 'a', phaseIdx: 0,
      provider: 'x', inputTokens: 1, outputTokens: 1, costUSD: 0.20,
    }, { writerId, runId });
    appendEvent(runDir, {
      event: 'phase.externalRef', phase: 'a', phaseIdx: 0,
      ref: { kind: 'github-pr', id: '7', observedAt: new Date().toISOString() },
    }, { writerId, runId });
    appendEvent(runDir, {
      event: 'phase.externalRef', phase: 'a', phaseIdx: 0,
      // duplicate kind+id — should dedup.
      ref: { kind: 'github-pr', id: '7', observedAt: new Date().toISOString() },
    }, { writerId, runId });
    appendEvent(runDir, {
      event: 'phase.success', phase: 'a', phaseIdx: 0,
      durationMs: 100, artifacts: [],
    }, { writerId, runId });
    appendEvent(runDir, {
      event: 'phase.start', phase: 'a', phaseIdx: 0,
      idempotent: true, hasSideEffects: false, attempt: 2,
    }, { writerId, runId });
    return { events: readEvents(runDir).events, runDir };
  }

  it('sumPhaseCost sums only matching phaseIdx', () => {
    const { events, runDir } = build();
    assert.ok(Math.abs(sumPhaseCost(events, 0) - 0.30) < 1e-9);
    assert.equal(sumPhaseCost(events, 1), 0);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('collectExternalRefs dedups by kind+id', () => {
    const { events, runDir } = build();
    const refs = collectExternalRefs(events, 0);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.id, '7');
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('countPhaseSuccesses + countPhaseAttempts honor phaseIdx', () => {
    const { events, runDir } = build();
    assert.equal(countPhaseSuccesses(events, 0), 1);
    assert.equal(countPhaseAttempts(events, 0), 2);
    assert.equal(countPhaseSuccesses(events, 1), 0);
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
