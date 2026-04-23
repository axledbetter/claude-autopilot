import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { withWriteLock } from '../../src/core/mcp/concurrency.ts';

describe('withWriteLock', () => {
  it('runs a single task immediately', async () => {
    const result = await withWriteLock('/workspace/a', async () => 42);
    assert.equal(result, 42);
  });

  it('serializes concurrent writes to the same workspace', async () => {
    const order: number[] = [];
    const t1 = withWriteLock('/workspace/b', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(1);
    });
    const t2 = withWriteLock('/workspace/b', async () => {
      order.push(2);
    });
    await Promise.all([t1, t2]);
    assert.deepEqual(order, [1, 2]);
  });

  it('allows concurrent writes to different workspaces', async () => {
    const order: string[] = [];
    const t1 = withWriteLock('/workspace/c', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push('c1');
    });
    const t2 = withWriteLock('/workspace/d', async () => {
      order.push('d1');
    });
    await Promise.all([t1, t2]);
    // d1 should finish before c1 (no lock contention)
    assert.equal(order[0], 'd1');
    assert.equal(order[1], 'c1');
  });

  it('releases lock even when fn throws', async () => {
    await assert.rejects(
      () => withWriteLock('/workspace/e', async () => { throw new Error('boom'); }),
      /boom/,
    );
    // Should be able to acquire lock again
    const result = await withWriteLock('/workspace/e', async () => 'ok');
    assert.equal(result, 'ok');
  });
});
