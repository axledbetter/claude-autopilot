// @snapshot-for: scripts/snapshots/impact-selector.ts
// @generated-at: 2026-04-21T17:42:06.431Z
// @source-commit: d207869
// @generator-version: 1.0.0-alpha.6

import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { selectSnapshots } from '../../scripts/snapshots/impact-selector.ts';
import { normalizeSnapshot } from '../../scripts/snapshots/serializer.ts';

const SLUG = 'src-snapshots-impact-selector';
const baselineRaw = process.env.CAPTURE_BASELINE === '1' ? '{}' : fs.readFileSync(fileURLToPath(new URL('./baselines/src-snapshots-impact-selector.json', import.meta.url)), 'utf8');
const baseline = JSON.parse(baselineRaw);
const captured: Record<string, unknown> = {};

process.on('exit', () => {
  if (process.env.CAPTURE_BASELINE === '1') {
    const p = process.env.AUTOREGRESS_TEMP_BASELINE_DIR
      ? path.join(process.env.AUTOREGRESS_TEMP_BASELINE_DIR, 'src-snapshots-impact-selector.json')
      : fileURLToPath(new URL('./baselines/src-snapshots-impact-selector.json', import.meta.url));
    fs.writeFileSync(p, JSON.stringify(captured, null, 2), 'utf8');
  }
});

describe(SLUG, () => {
  it('volume override triggers full run', () => {
    const changedFiles = Array.from({ length: 11 }, (_, i) => `src/feature/file-${i}.ts`);
    const allSnapshotFiles = ['a.snap', 'b.snap', 'c.snap'];

    const result = selectSnapshots(changedFiles, allSnapshotFiles, {}, {}, {});

    if (process.env.CAPTURE_BASELINE === '1') {
      captured['volume override triggers full run'] = result;
      return;
    }
    assert.equal(normalizeSnapshot(result), normalizeSnapshot(baseline['volume override triggers full run']));
  });

  it('high-impact path match triggers full run', () => {
    const changedFiles = ['src/core/pipeline/runner.ts'];
    const allSnapshotFiles = ['x.snap', 'y.snap'];

    const result = selectSnapshots(changedFiles, allSnapshotFiles, {}, {}, {});

    if (process.env.CAPTURE_BASELINE === '1') {
      captured['high-impact path match triggers full run'] = result;
      return;
    }
    assert.equal(normalizeSnapshot(result), normalizeSnapshot(baseline['high-impact path match triggers full run']));
  });

  it('selects snapshots via direct and importer mapping', () => {
    const changedFiles = ['src/features/a.ts'];
    const allSnapshotFiles = ['snap-a.snap', 'snap-b.snap', 'snap-c.snap'];
    const index = {
      'snap-a.snap': ['src/features/a.ts'],
      'snap-b.snap': ['src/features/b.ts'],
      'snap-c.snap': ['src/features/c.ts'],
    };
    const importMap = {
      'src/features/a.ts': ['src/features/b.ts'],
    };

    const result = selectSnapshots(changedFiles, allSnapshotFiles, index, importMap, {
      highImpactPatterns: [],
      volumeThreshold: 50,
    });

    if (process.env.CAPTURE_BASELINE === '1') {
      captured['selects snapshots via direct and importer mapping'] = result;
      return;
    }
    assert.equal(normalizeSnapshot(result), normalizeSnapshot(baseline['selects snapshots via direct and importer mapping']));
  });

  it('returns no matches reason when nothing selected', () => {
    const result = selectSnapshots(
      ['src/unknown/file.ts'],
      ['only.snap'],
      { 'only.snap': ['src/other/file.ts'] },
      {},
      { highImpactPatterns: [], volumeThreshold: 50 },
    );

    if (process.env.CAPTURE_BASELINE === '1') {
      captured['returns no matches reason when nothing selected'] = result;
      return;
    }
    assert.equal(normalizeSnapshot(result), normalizeSnapshot(baseline['returns no matches reason when nothing selected']));
  });
});
