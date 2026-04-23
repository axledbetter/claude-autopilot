// @snapshot-for: scripts/snapshots/serializer.ts
// @generated-at: 2026-04-21T17:42:06.431Z
// @source-commit: d207869
// @generator-version: 1.0.0-alpha.6

import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { normalizeSnapshot } from '../../scripts/snapshots/serializer.ts';

const SLUG = 'src-snapshots-serializer';
const baselineRaw = process.env.CAPTURE_BASELINE === '1' ? '{}' : fs.readFileSync(fileURLToPath(new URL('./baselines/src-snapshots-serializer.json', import.meta.url)), 'utf8');
const baseline = JSON.parse(baselineRaw);
const captured: Record<string, unknown> = {};
process.on('exit', () => {
  if (process.env.CAPTURE_BASELINE === '1') {
    const p = process.env.AUTOREGRESS_TEMP_BASELINE_DIR
      ? path.join(process.env.AUTOREGRESS_TEMP_BASELINE_DIR, 'src-snapshots-serializer.json')
      : fileURLToPath(new URL('./baselines/src-snapshots-serializer.json', import.meta.url));
    fs.writeFileSync(p, JSON.stringify(captured, null, 2), 'utf8');
  }
});

describe('normalizeSnapshot', () => {
  it('normalizes timestamps uuids and cwd-prefixed paths', () => {
    const cwd = '/repo/project';
    const result = JSON.parse(normalizeSnapshot({
      ts: '2026-04-21T17:42:06.431Z',
      id: '550e8400-e29b-41d4-a716-446655440000',
      path: '/repo/project/src/index.ts',
      untouched: '/other/place/file.ts',
    }, cwd));

    if (process.env.CAPTURE_BASELINE === '1') { captured['normalizes timestamps uuids and cwd-prefixed paths'] = result; return; }
    assert.equal(normalizeSnapshot(result), normalizeSnapshot(baseline['normalizes timestamps uuids and cwd-prefixed paths']));
  });

  it('recursively normalizes arrays and nested objects', () => {
    const cwd = '/work';
    const result = JSON.parse(normalizeSnapshot({
      items: [
        '2024-01-02T03:04:05.000Z',
        { uid: '123e4567-e89b-12d3-a456-426614174000', file: '/work/a/b.txt' },
        ['plain', '/work/c/d.ts'],
      ],
    }, cwd));

    if (process.env.CAPTURE_BASELINE === '1') { captured['recursively normalizes arrays and nested objects'] = result; return; }
    assert.equal(normalizeSnapshot(result), normalizeSnapshot(baseline['recursively normalizes arrays and nested objects']));
  });

  it('sorts object keys deterministically at all levels', () => {
    const result = JSON.parse(normalizeSnapshot({
      z: 1,
      a: { d: 4, b: 2, c: 3 },
      m: [{ y: 2, x: 1 }, { b: 2, a: 1 }],
    }));

    if (process.env.CAPTURE_BASELINE === '1') { captured['sorts object keys deterministically at all levels'] = result; return; }
    assert.equal(normalizeSnapshot(result), normalizeSnapshot(baseline['sorts object keys deterministically at all levels']));
  });
});
