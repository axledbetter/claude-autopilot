import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendEvent,
  eventsPath,
  foldEvents,
  readEvents,
  readMaxSeq,
  replayState,
} from '../../src/core/run-state/events.ts';
import { makeWriterId } from '../../src/core/run-state/lock.ts';
import type { RunEvent, WriterId } from '../../src/core/run-state/types.ts';
import { GuardrailError } from '../../src/core/errors.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-events-'));
}

const writerId: WriterId = makeWriterId();

describe('appendEvent', () => {
  it('writes a single event with seq=1, fsync via O_APPEND', () => {
    const dir = tmp();
    const ev = appendEvent(
      dir,
      { event: 'run.start', phases: ['a', 'b'] },
      { writerId, runId: 'TESTRUN' },
    );
    assert.equal(ev.seq, 1);
    assert.equal(ev.event, 'run.start');
    assert.equal(ev.runId, 'TESTRUN');
    assert.equal(ev.schema_version, 1);
    assert.deepEqual((ev as RunEvent & { event: 'run.start' }).phases, ['a', 'b']);
    const raw = fs.readFileSync(eventsPath(dir), 'utf8');
    assert.ok(raw.endsWith('\n'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('assigns monotonic seq across multiple appends', () => {
    const dir = tmp();
    appendEvent(dir, { event: 'run.start', phases: ['a'] }, { writerId, runId: 'R1' });
    appendEvent(dir, {
      event: 'phase.start', phase: 'a', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    }, { writerId, runId: 'R1' });
    appendEvent(dir, {
      event: 'phase.success', phase: 'a', phaseIdx: 0,
      durationMs: 100, artifacts: [],
    }, { writerId, runId: 'R1' });
    const { events } = readEvents(dir);
    assert.deepEqual(events.map(e => e.seq), [1, 2, 3]);
    assert.equal(readMaxSeq(dir), 3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readEvents respects fromSeq and tail filters', () => {
    const dir = tmp();
    appendEvent(dir, { event: 'run.start', phases: ['a'] }, { writerId, runId: 'R1' });
    for (let i = 0; i < 4; i++) {
      appendEvent(dir, {
        event: 'phase.cost', phase: 'a', phaseIdx: 0,
        provider: 'p', inputTokens: 0, outputTokens: 0, costUSD: 0.1,
      }, { writerId, runId: 'R1' });
    }
    const fromSeq3 = readEvents(dir, { fromSeq: 3 });
    assert.deepEqual(fromSeq3.events.map(e => e.seq), [3, 4, 5]);
    const tail2 = readEvents(dir, { tail: 2 });
    assert.deepEqual(tail2.events.map(e => e.seq), [4, 5]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects truncated tail and emits run.recovery on next append', () => {
    const dir = tmp();
    appendEvent(dir, { event: 'run.start', phases: ['a'] }, { writerId, runId: 'R1' });
    // Corrupt the file by appending a partial JSON line WITHOUT trailing newline.
    fs.appendFileSync(eventsPath(dir), '{"partial":', 'utf8');

    const r = readEvents(dir);
    assert.equal(r.truncatedTail, true);
    // The truncated tail is dropped from the returned events.
    assert.equal(r.events.length, 1);
    // Marker file present.
    assert.ok(fs.existsSync(path.join(dir, '.partial-write')));

    // Next append should emit a recovery event THEN our new event.
    appendEvent(dir, {
      event: 'phase.start', phase: 'a', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    }, { writerId, runId: 'R1' });

    const after = readEvents(dir);
    // Expect: run.start, run.recovery, phase.start
    assert.equal(after.events.length, 3);
    assert.equal(after.events[1]!.event, 'run.recovery');
    assert.equal(after.events[2]!.event, 'phase.start');
    // Marker is cleared.
    assert.equal(fs.existsSync(path.join(dir, '.partial-write')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readEvents throws partial_write on mid-file corruption', () => {
    const dir = tmp();
    // Write 2 valid lines and one mid-file corrupt one followed by a valid line
    // with proper trailing newline (so tail-truncation check doesn't grab it).
    fs.writeFileSync(eventsPath(dir),
      '{"schema_version":1,"ts":"2026-01-01","runId":"X","seq":1,"writerId":{"pid":1,"hostHash":"h"},"event":"run.start","phases":[]}\n' +
      '{this is bogus}\n' +
      '{"schema_version":1,"ts":"2026-01-01","runId":"X","seq":3,"writerId":{"pid":1,"hostHash":"h"},"event":"run.complete","status":"success","totalCostUSD":0,"durationMs":0}\n',
      'utf8',
    );
    assert.throws(
      () => readEvents(dir),
      (err: unknown) =>
        err instanceof GuardrailError && err.code === 'partial_write',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readMaxSeq returns 0 for an empty/missing log', () => {
    const dir = tmp();
    assert.equal(readMaxSeq(dir), 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('replayState / foldEvents', () => {
  it('returns a stub when run.start has not landed yet', () => {
    const dir = tmp();
    const s = replayState(dir);
    assert.equal(s.status, 'pending');
    assert.equal(s.phases.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('builds a coherent snapshot from an event sequence', () => {
    const dir = tmp();
    appendEvent(dir, { event: 'run.start', phases: ['plan', 'impl'] },
      { writerId, runId: 'R' });
    appendEvent(dir, {
      event: 'phase.start', phase: 'plan', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    }, { writerId, runId: 'R' });
    appendEvent(dir, {
      event: 'phase.cost', phase: 'plan', phaseIdx: 0,
      provider: 'anthropic', inputTokens: 100, outputTokens: 50, costUSD: 0.42,
    }, { writerId, runId: 'R' });
    appendEvent(dir, {
      event: 'phase.success', phase: 'plan', phaseIdx: 0,
      durationMs: 5000, artifacts: [{ name: 'plan', path: 'artifacts/plan.md' }],
    }, { writerId, runId: 'R' });
    appendEvent(dir, {
      event: 'phase.start', phase: 'impl', phaseIdx: 1,
      idempotent: false, hasSideEffects: true, attempt: 1,
    }, { writerId, runId: 'R' });
    appendEvent(dir, {
      event: 'phase.failed', phase: 'impl', phaseIdx: 1,
      durationMs: 1000, error: 'tsc failed',
    }, { writerId, runId: 'R' });

    const s = replayState(dir);
    assert.equal(s.status, 'paused'); // because impl failed
    assert.equal(s.phases.length, 2);
    assert.equal(s.phases[0]!.status, 'succeeded');
    assert.equal(s.phases[0]!.costUSD, 0.42);
    assert.equal(s.phases[0]!.artifacts.length, 1);
    assert.equal(s.phases[1]!.status, 'failed');
    assert.equal(s.phases[1]!.lastError, 'tsc failed');
    assert.equal(s.totalCostUSD, 0.42);
    assert.equal(s.lastEventSeq, 6);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws corrupted_state on a seq gap', () => {
    const dir = tmp();
    fs.writeFileSync(eventsPath(dir),
      '{"schema_version":1,"ts":"2026-01-01","runId":"X","seq":1,"writerId":{"pid":1,"hostHash":"h"},"event":"run.start","phases":["a"]}\n' +
      '{"schema_version":1,"ts":"2026-01-01","runId":"X","seq":3,"writerId":{"pid":1,"hostHash":"h"},"event":"phase.start","phase":"a","phaseIdx":0,"idempotent":false,"hasSideEffects":false,"attempt":1}\n',
      'utf8');
    assert.throws(
      () => replayState(dir),
      (err: unknown) =>
        err instanceof GuardrailError && err.code === 'corrupted_state',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('foldEvents dedupes externalRefs by kind+id', () => {
    const dir = tmp();
    const events = [
      { schema_version: 1, ts: 't', runId: 'R', seq: 1, writerId,
        event: 'run.start', phases: ['pr'] },
      { schema_version: 1, ts: 't', runId: 'R', seq: 2, writerId,
        event: 'phase.start', phase: 'pr', phaseIdx: 0,
        idempotent: false, hasSideEffects: true, attempt: 1 },
      { schema_version: 1, ts: 't', runId: 'R', seq: 3, writerId,
        event: 'phase.externalRef', phase: 'pr', phaseIdx: 0,
        ref: { kind: 'github-pr', id: '42', observedAt: 't' } },
      { schema_version: 1, ts: 't', runId: 'R', seq: 4, writerId,
        event: 'phase.externalRef', phase: 'pr', phaseIdx: 0,
        ref: { kind: 'github-pr', id: '42', observedAt: 't' } },
    ] as RunEvent[];
    const s = foldEvents(dir, events);
    assert.equal(s.phases[0]!.externalRefs.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
