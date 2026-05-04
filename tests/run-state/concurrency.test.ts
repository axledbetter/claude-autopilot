// tests/run-state/concurrency.test.ts
//
// Multi-writer collision tests for the per-run advisory lock + append
// protocol. These run in-process (proper-lockfile is advisory file-based,
// so a second acquire from the same PID is still rejected per its
// implementation — we don't need a child process to exercise the gate).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireRunLock } from '../../src/core/run-state/lock.ts';
import { appendEvent, readEvents } from '../../src/core/run-state/events.ts';
import { GuardrailError } from '../../src/core/errors.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-conc-'));
}

describe('per-run advisory lock — concurrency', () => {
  it('second acquire fails fast with lock_held while first is held', async () => {
    const dir = tmp();
    const a = await acquireRunLock(dir);
    try {
      await assert.rejects(
        acquireRunLock(dir, { retries: 0 }),
        (err: unknown) =>
          err instanceof GuardrailError &&
          err.code === 'lock_held' &&
          typeof err.details.runDir === 'string',
      );
    } finally {
      await a.release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('after release the next writer acquires cleanly', async () => {
    const dir = tmp();
    const a = await acquireRunLock(dir);
    await a.release();
    const b = await acquireRunLock(dir);
    await b.release();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serial appends from one writer maintain monotonic seq', async () => {
    const dir = tmp();
    const handle = await acquireRunLock(dir);
    try {
      appendEvent(dir, { event: 'run.start', phases: ['a'] },
        { writerId: handle.writerId, runId: 'R' });
      for (let i = 0; i < 20; i++) {
        appendEvent(dir, {
          event: 'phase.cost', phase: 'a', phaseIdx: 0,
          provider: 'p', inputTokens: 0, outputTokens: 0, costUSD: 0.01,
        }, { writerId: handle.writerId, runId: 'R' });
      }
      const { events, maxSeq } = readEvents(dir);
      assert.equal(events.length, 21);
      assert.equal(maxSeq, 21);
      // Every seq is dense [1..21].
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i]!.seq, i + 1);
      }
    } finally {
      await handle.release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
