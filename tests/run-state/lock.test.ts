import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireRunLock,
  forceTakeover,
  isPidAlive,
  makeWriterId,
  peekLockOwner,
  updateLockSeq,
} from '../../src/core/run-state/lock.ts';
import { GuardrailError } from '../../src/core/errors.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-lock-'));
}

describe('run-state lock', () => {
  it('acquires and releases the lock cleanly', async () => {
    const dir = tmp();
    const handle = await acquireRunLock(dir);
    assert.ok(handle.writerId.pid > 0);
    assert.ok(handle.writerId.hostHash.length === 16);
    const meta = peekLockOwner(dir);
    assert.equal(meta?.writerId.pid, handle.writerId.pid);
    await handle.release();
    // After release, meta is gone.
    assert.equal(peekLockOwner(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a second acquire with GuardrailError(lock_held)', async () => {
    const dir = tmp();
    const a = await acquireRunLock(dir);
    try {
      await assert.rejects(
        acquireRunLock(dir),
        (err: unknown) =>
          err instanceof GuardrailError && err.code === 'lock_held',
      );
    } finally {
      await a.release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updateLockSeq writes the lastSeq into meta', async () => {
    const dir = tmp();
    const handle = await acquireRunLock(dir);
    updateLockSeq(dir, 42);
    const meta = peekLockOwner(dir);
    assert.equal(meta?.lastSeq, 42);
    await handle.release();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('forceTakeover refuses while previous PID is still alive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-lock-takeover-'));
    fs.mkdirSync(dir, { recursive: true });
    // Plant a meta file for a writerId we know is alive: ourselves.
    const me = makeWriterId();
    fs.writeFileSync(
      path.join(dir, '.lock-meta.json'),
      JSON.stringify({ writerId: me, acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    assert.throws(
      () => forceTakeover(dir, 'test'),
      (err: unknown) =>
        err instanceof GuardrailError && err.code === 'lock_held',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('forceTakeover succeeds when previous writer is on this host but dead PID', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-lock-takeover2-'));
    fs.mkdirSync(dir, { recursive: true });
    const me = makeWriterId();
    // Use a PID that's almost certainly not alive (very large).
    fs.writeFileSync(
      path.join(dir, '.lock-meta.json'),
      JSON.stringify({
        writerId: { pid: 999_999_999, hostHash: me.hostHash },
        acquiredAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const ev = forceTakeover(dir, 'reclaim');
    assert.equal(ev.event, 'lock.takeover');
    assert.equal(ev.reason, 'reclaim');
    assert.equal(ev.previousWriter?.pid, 999_999_999);
    // Meta should be cleared.
    assert.equal(peekLockOwner(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('isPidAlive treats off-host writers as alive (refuses to determine)', () => {
    const otherHost = { pid: 1, hostHash: 'aaaaaaaaaaaaaaaa' };
    assert.equal(isPidAlive(otherHost), true);
  });

  it('isPidAlive returns false for a dead local PID', () => {
    const me = makeWriterId();
    assert.equal(isPidAlive({ pid: 999_999_999, hostHash: me.hostHash }), false);
  });

  it('peekLockOwner returns null when no metadata exists', () => {
    const dir = tmp();
    assert.equal(peekLockOwner(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
