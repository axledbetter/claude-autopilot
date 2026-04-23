import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectSnapshots } from '../../scripts/snapshots/impact-selector.ts';

const INDEX: Record<string, string[]> = {
  'tests/snapshots/sarif.snap.ts': ['src/formatters/sarif.ts'],
  'tests/snapshots/annotations.snap.ts': ['src/formatters/github-annotations.ts'],
  'tests/snapshots/pipeline.snap.ts': ['src/core/pipeline/run.ts'],
};
const IMPORT_MAP: Record<string, string[]> = {
  'src/formatters/sarif.ts': ['src/cli/run.ts', 'src/formatters/index.ts'],
  'src/formatters/github-annotations.ts': ['src/formatters/index.ts'],
};
const ALL_SNAPS = Object.keys(INDEX);

describe('selectSnapshots', () => {
  it('AR7: direct hit — changed file matches @snapshot-for source', () => {
    const result = selectSnapshots(
      ['src/formatters/sarif.ts'],
      ALL_SNAPS,
      INDEX,
      IMPORT_MAP,
    );
    assert.ok(!result.fullRun);
    assert.ok(result.selected.includes('tests/snapshots/sarif.snap.ts'));
    assert.ok(!result.selected.includes('tests/snapshots/annotations.snap.ts'));
  });

  it('AR8: one-hop expansion — direct hit on coverage target', () => {
    const customIndex: Record<string, string[]> = {
      'tests/snapshots/annotations.snap.ts': ['src/formatters/github-annotations.ts'],
    };
    const customImportMap: Record<string, string[]> = {
      'src/formatters/github-annotations.ts': ['src/formatters/index.ts'],
    };
    const result = selectSnapshots(
      ['src/formatters/github-annotations.ts'],
      ['tests/snapshots/annotations.snap.ts'],
      customIndex,
      customImportMap,
    );
    assert.ok(result.selected.includes('tests/snapshots/annotations.snap.ts'));
  });

  it('AR9: high-impact path override — changes in src/core/pipeline/** run all snapshots', () => {
    const result = selectSnapshots(
      ['src/core/pipeline/run.ts'],
      ALL_SNAPS,
      INDEX,
      IMPORT_MAP,
    );
    assert.ok(result.fullRun, 'Expected fullRun=true for high-impact path');
    assert.equal(result.selected.length, ALL_SNAPS.length);
    assert.match(result.reason, /high-impact/i);
  });

  it('AR10: volume override — more than 10 changed files triggers full run', () => {
    const many = Array.from({ length: 11 }, (_, i) => `src/misc/file${i}.ts`);
    const result = selectSnapshots(many, ALL_SNAPS, INDEX, IMPORT_MAP);
    assert.ok(result.fullRun);
    assert.match(result.reason, /volume/i);
  });
});
