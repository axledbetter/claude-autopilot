import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toSarif, normalizeSarifUri } from '../../src/formatters/sarif.ts';
import type { RunResult } from '../../src/core/pipeline/run.ts';
import type { Finding } from '../../src/core/findings/types.ts';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'static-rules',
    severity: 'warning',
    category: 'test-rule',
    file: 'src/foo.ts',
    message: 'something wrong',
    protectedPath: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeResult(findings: Finding[] = []): RunResult {
  return { status: 'pass', phases: [], allFindings: findings, durationMs: 100 };
}

const OPTS = { toolVersion: '1.0.0-test', cwd: '/repo' };

describe('toSarif', () => {
  it('S1: empty findings → valid SARIF with results: []', () => {
    const log = toSarif(makeResult([]), OPTS);
    assert.equal(log.version, '2.1.0');
    assert.equal(log.$schema, 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json');
    assert.equal(log.runs.length, 1);
    assert.deepEqual(log.runs[0]!.results, []);
    assert.deepEqual(log.runs[0]!.tool.driver.rules, []);
  });

  it('S2: critical → level "error"', () => {
    const log = toSarif(makeResult([makeFinding({ severity: 'critical' })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.level, 'error');
  });

  it('S3: warning → level "warning"', () => {
    const log = toSarif(makeResult([makeFinding({ severity: 'warning' })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.level, 'warning');
  });

  it('S4: note → level "note"', () => {
    const log = toSarif(makeResult([makeFinding({ severity: 'note' })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.level, 'note');
  });

  it('S5: finding with line → region.startLine set', () => {
    const log = toSarif(makeResult([makeFinding({ line: 42 })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.locations[0]!.physicalLocation.region?.startLine, 42);
  });

  it('S6: finding without line → no region property', () => {
    const log = toSarif(makeResult([makeFinding({ line: undefined })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.locations[0]!.physicalLocation.region, undefined);
  });

  it('S7: two findings same category → one rule in driver.rules', () => {
    const findings = [
      makeFinding({ id: 'f1', category: 'dupe-rule' }),
      makeFinding({ id: 'f2', category: 'dupe-rule' }),
    ];
    const log = toSarif(makeResult(findings), OPTS);
    assert.equal(log.runs[0]!.tool.driver.rules.length, 1);
    assert.equal(log.runs[0]!.tool.driver.rules[0]!.id, 'dupe-rule');
  });

  it('S8: suggestion present → fixes[0].description.text', () => {
    const log = toSarif(makeResult([makeFinding({ suggestion: 'use X instead' })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.fixes?.[0]?.description.text, 'use X instead');
  });

  it('S9: absolute path → repo-relative forward-slash', () => {
    const log = toSarif(makeResult([makeFinding({ file: '/repo/src/foo.ts' })]), OPTS);
    assert.equal(
      log.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri,
      'src/foo.ts',
    );
  });

  it('S10: Windows backslash path → forward-slash', () => {
    assert.equal(normalizeSarifUri('src\\foo\\bar.ts', '/repo'), 'src/foo/bar.ts');
  });

  it('S11: ./prefix → stripped', () => {
    assert.equal(normalizeSarifUri('./src/foo.ts', '/repo'), 'src/foo.ts');
  });
});
