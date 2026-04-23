import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../../scripts/snapshots/serializer.ts';

describe('normalizeSnapshot', () => {
  it('AR1: sorts object keys alphabetically (recursive)', () => {
    const input = { z: 1, a: 2, m: { y: 3, b: 4 } };
    const out = JSON.parse(normalizeSnapshot(input));
    assert.deepEqual(Object.keys(out), ['a', 'm', 'z']);
    assert.deepEqual(Object.keys(out.m), ['b', 'y']);
  });

  it('AR2: replaces ISO timestamp strings with <timestamp>', () => {
    const input = { ts: '2026-04-21T16:00:00Z', nested: { at: '2020-01-01T00:00:00.000Z' } };
    const out = JSON.parse(normalizeSnapshot(input));
    assert.equal(out.ts, '<timestamp>');
    assert.equal(out.nested.at, '<timestamp>');
  });

  it('AR3: replaces UUID strings with <uuid>', () => {
    const input = { id: '550e8400-e29b-41d4-a716-446655440000', name: 'keep-me' };
    const out = JSON.parse(normalizeSnapshot(input));
    assert.equal(out.id, '<uuid>');
    assert.equal(out.name, 'keep-me');
  });

  it('AR4: strips cwd prefix from absolute path strings', () => {
    const cwd = '/repo/myproject';
    const input = { file: '/repo/myproject/src/foo.ts', other: '/different/path.ts' };
    const out = JSON.parse(normalizeSnapshot(input, cwd));
    assert.equal(out.file, 'src/foo.ts');
    assert.equal(out.other, '/different/path.ts');
  });
});
