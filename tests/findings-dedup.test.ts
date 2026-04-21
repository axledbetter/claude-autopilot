import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Finding } from '../src/core/findings/types.ts';
import { dedupFindings } from '../src/core/findings/dedup.ts';

function f(p: Partial<Finding>): Finding {
  return {
    id: 'tmp', source: 'static-rules', severity: 'warning', category: 'test',
    file: 'src/x.ts', message: 'msg', protectedPath: false,
    createdAt: '2026-04-20T00:00:00.000Z', ...p,
  };
}

test('dedupFindings removes exact duplicates on (file, line, severity, msg-head)', () => {
  const a = f({ id: 'a', file: 'src/x.ts', line: 10, severity: 'critical', message: 'leaked key' });
  const b = f({ id: 'b', file: 'src/x.ts', line: 10, severity: 'critical', message: 'leaked key' });
  const c = f({ id: 'c', file: 'src/y.ts', line: 10, severity: 'critical', message: 'leaked key' });
  const result = dedupFindings([a, b, c]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(r => r.id).sort(), ['a', 'c']);
});

test('dedupFindings treats different severity as different', () => {
  const a = f({ id: 'a', severity: 'warning', message: 'same msg' });
  const b = f({ id: 'b', severity: 'critical', message: 'same msg' });
  assert.equal(dedupFindings([a, b]).length, 2);
});

test('dedupFindings uses first 40 chars of message as dedup key', () => {
  const a = f({ id: 'a', message: 'X'.repeat(40) + ' suffix A' });
  const b = f({ id: 'b', message: 'X'.repeat(40) + ' suffix B' });
  assert.equal(dedupFindings([a, b]).length, 1);
});
