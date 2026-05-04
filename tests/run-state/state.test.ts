import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readStateSnapshot,
  recoverState,
  statePath,
  writeStateSnapshot,
} from '../../src/core/run-state/state.ts';
import { appendEvent, readEvents } from '../../src/core/run-state/events.ts';
import { makeWriterId } from '../../src/core/run-state/lock.ts';
import {
  RUN_STATE_SCHEMA_VERSION,
  type RunState,
} from '../../src/core/run-state/types.ts';
import { GuardrailError } from '../../src/core/errors.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-state-'));
}

const writerId = makeWriterId();

function freshState(runDir: string): RunState {
  return {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    runId: path.basename(runDir),
    startedAt: new Date().toISOString(),
    status: 'pending',
    phases: [],
    currentPhaseIdx: 0,
    totalCostUSD: 0,
    lastEventSeq: 0,
    writerId,
    cwd: runDir,
  };
}

describe('writeStateSnapshot', () => {
  it('writes state.json atomically (via .tmp + rename)', () => {
    const dir = tmp();
    const state = freshState(dir);
    writeStateSnapshot(dir, state);
    // Final file present, no leftover .tmp.
    assert.ok(fs.existsSync(statePath(dir)));
    assert.equal(fs.existsSync(path.join(dir, 'state.json.tmp')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips via readStateSnapshot', () => {
    const dir = tmp();
    const state = freshState(dir);
    state.totalCostUSD = 1.23;
    writeStateSnapshot(dir, state);
    const got = readStateSnapshot(dir);
    assert.equal(got?.totalCostUSD, 1.23);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readStateSnapshot returns null when missing', () => {
    const dir = tmp();
    assert.equal(readStateSnapshot(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readStateSnapshot throws corrupted_state on garbage', () => {
    const dir = tmp();
    fs.writeFileSync(statePath(dir), '{not json', 'utf8');
    assert.throws(
      () => readStateSnapshot(dir),
      (err: unknown) =>
        err instanceof GuardrailError && err.code === 'corrupted_state',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('overwriting an existing snapshot leaves no .tmp behind', () => {
    const dir = tmp();
    const a = freshState(dir);
    writeStateSnapshot(dir, a);
    const b = { ...a, totalCostUSD: 9.99 };
    writeStateSnapshot(dir, b);
    assert.equal(fs.existsSync(path.join(dir, 'state.json.tmp')), false);
    assert.equal(readStateSnapshot(dir)?.totalCostUSD, 9.99);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('recoverState', () => {
  it('returns the snapshot unchanged when healthy', () => {
    const dir = tmp();
    const state = freshState(dir);
    state.totalCostUSD = 5;
    writeStateSnapshot(dir, state);
    const r = recoverState(dir, { writerId });
    assert.equal(r.recovered, false);
    assert.equal(r.state.totalCostUSD, 5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds from events.ndjson when state.json is missing', () => {
    const dir = tmp();
    appendEvent(dir, { event: 'run.start', phases: ['a'] }, { writerId, runId: path.basename(dir) });
    appendEvent(dir, {
      event: 'phase.start', phase: 'a', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    }, { writerId, runId: path.basename(dir) });
    appendEvent(dir, {
      event: 'phase.success', phase: 'a', phaseIdx: 0,
      durationMs: 100, artifacts: [],
    }, { writerId, runId: path.basename(dir) });
    const r = recoverState(dir, { writerId, runId: path.basename(dir) });
    assert.equal(r.recovered, true);
    assert.equal(r.cause, 'missing');
    assert.equal(r.state.phases[0]!.status, 'succeeded');
    // index.rebuilt event should have been written.
    const { events } = readEvents(dir);
    const rebuilt = events.find(e => e.event === 'index.rebuilt');
    assert.ok(rebuilt, 'expected index.rebuilt event');
    // Snapshot now exists.
    assert.ok(readStateSnapshot(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds from events.ndjson when state.json is corrupt', () => {
    const dir = tmp();
    appendEvent(dir, { event: 'run.start', phases: ['x'] }, { writerId, runId: path.basename(dir) });
    fs.writeFileSync(statePath(dir), '<corrupt>', 'utf8');
    const r = recoverState(dir, { writerId, runId: path.basename(dir) });
    assert.equal(r.recovered, true);
    assert.equal(r.cause, 'corrupt');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
