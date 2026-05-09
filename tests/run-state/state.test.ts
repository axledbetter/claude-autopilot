import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readStateSnapshot,
  recoverState,
  RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION,
  RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION,
  statePath,
  writeStateSnapshot,
} from '../../src/core/run-state/state.ts';
import { appendEvent, readEvents, replayState, eventsPath } from '../../src/core/run-state/events.ts';
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

// ----------------------------------------------------------------------------
// v6.2.2 — schema_version range guard in replayState (per spec / codex
// WARNING #1). Validates the MIN/MAX window: equal-to-current is accepted,
// out-of-range throws corrupted_state with both bounds in the message.
// ----------------------------------------------------------------------------

describe('replayState — schema_version range guard (v6.2.2)', () => {
  it('exports the policy bounds with sensible defaults', () => {
    assert.equal(RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION, 1);
    assert.equal(RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION, RUN_STATE_SCHEMA_VERSION);
    assert.ok(
      RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION <= RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION,
      'min must be <= max',
    );
  });

  // v7.0 — schema bumped from 1 → 2 with v6 read back-compat preserved.
  it('v7.0: RUN_STATE_SCHEMA_VERSION === 2', () => {
    assert.equal(RUN_STATE_SCHEMA_VERSION, 2);
  });

  it('v7.0: MIN_SUPPORTED stays at 1 — v6.x runs (schema_version=1) are still readable', () => {
    assert.equal(RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION, 1);
    const dir = tmp();
    writeForcedRunStart(dir, 1);
    // v6 dir replays without throwing on a v7 binary.
    const state = replayState(dir);
    assert.equal(state.runId, path.basename(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('v7.0: schema_version above MAX includes "downgrade resume is not supported" hint + [1..2] range', () => {
    // Simulate a v8-written run dir replayed by a v7 binary — the same
    // shape a v6 binary would see when reading a v7-written dir.
    const dir = tmp();
    writeForcedRunStart(dir, RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION + 1);
    let caught: unknown;
    try {
      replayState(dir);
    } catch (err) { caught = err; }
    assert.ok(caught instanceof GuardrailError);
    const msg = (caught as GuardrailError).message;
    assert.ok(
      msg.includes('downgrade resume is not supported'),
      `expected "downgrade resume is not supported" hint; got: ${msg}`,
    );
    assert.ok(
      msg.includes(`[${RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION}..${RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION}]`),
      `expected "[1..2]" range; got: ${msg}`,
    );
    assert.ok(
      msg.includes(`schema_version=${RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION + 1}`),
      `expected observed schema_version in message; got: ${msg}`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Build an events.ndjson with a single run.start whose schema_version
   *  is forced to `version`. Bypasses appendEvent so we can inject an
   *  out-of-range value that the writer would never produce naturally. */
  function writeForcedRunStart(runDir: string, version: number): void {
    const event = {
      schema_version: version,
      ts: new Date().toISOString(),
      runId: path.basename(runDir),
      seq: 1,
      writerId,
      event: 'run.start',
      phases: ['scan'],
    };
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(eventsPath(runDir), JSON.stringify(event) + '\n', 'utf8');
  }

  it('accepts schema_version inside the supported range', () => {
    const dir = tmp();
    writeForcedRunStart(dir, RUN_STATE_SCHEMA_VERSION);
    // Should not throw — the value is exactly at the upper bound.
    const state = replayState(dir);
    assert.equal(state.runId, path.basename(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws corrupted_state when schema_version is below MIN_SUPPORTED', () => {
    const dir = tmp();
    writeForcedRunStart(dir, RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION - 1);
    assert.throws(
      () => replayState(dir),
      (err: unknown) =>
        err instanceof GuardrailError && err.code === 'corrupted_state',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws corrupted_state when schema_version is above MAX_SUPPORTED', () => {
    const dir = tmp();
    writeForcedRunStart(dir, RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION + 1);
    assert.throws(
      () => replayState(dir),
      (err: unknown) =>
        err instanceof GuardrailError && err.code === 'corrupted_state',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('range error message names both bounds for operator triage', () => {
    const dir = tmp();
    writeForcedRunStart(dir, RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION + 1);
    let caught: unknown;
    try {
      replayState(dir);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof GuardrailError, 'expected GuardrailError');
    const msg = (caught as GuardrailError).message;
    // Names both bounds explicitly so an operator can read the binary's
    // supported window straight from the error.
    assert.ok(
      msg.includes(`${RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION}..${RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION}`),
      `expected message to include "${RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION}..${RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION}", got: ${msg}`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
