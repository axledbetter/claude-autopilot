import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankByRisk } from '../src/core/chunking/risk-ranker.ts';

describe('rankByRisk', () => {
  it('puts protected paths first', () => {
    const files = ['src/utils.ts', 'data/deltas/20260101_add_table.sql', 'README.md'];
    const ranked = rankByRisk(files, { protectedPaths: ['data/deltas/**'] });
    assert.equal(ranked[0], 'data/deltas/20260101_add_table.sql');
  });

  it('puts auth files above plain logic', () => {
    const files = ['src/services/user.ts', 'src/auth/login.ts', 'src/utils/format.ts'];
    const ranked = rankByRisk(files);
    assert.equal(ranked[0], 'src/auth/login.ts');
  });

  it('puts payment files above core logic', () => {
    const files = ['src/services/policy.ts', 'src/payment/stripe.ts'];
    const ranked = rankByRisk(files);
    assert.equal(ranked[0], 'src/payment/stripe.ts');
  });

  it('pushes test files to the end', () => {
    const files = ['src/auth/login.ts', 'tests/auth.test.ts', 'src/core/pipeline.ts'];
    const ranked = rankByRisk(files);
    assert.equal(ranked[ranked.length - 1], 'tests/auth.test.ts');
  });

  it('pushes markdown docs to the very end', () => {
    const files = ['src/utils.ts', 'README.md', 'CHANGELOG.md'];
    const ranked = rankByRisk(files);
    assert.ok(ranked.indexOf('README.md') > ranked.indexOf('src/utils.ts'));
    assert.ok(ranked.indexOf('CHANGELOG.md') > ranked.indexOf('src/utils.ts'));
  });

  it('handles empty file list', () => {
    assert.deepEqual(rankByRisk([]), []);
  });

  it('does not mutate input array', () => {
    const files = ['a.ts', 'b.ts', 'c.ts'];
    const copy = [...files];
    rankByRisk(files);
    assert.deepEqual(files, copy);
  });

  it('multiple protected patterns all score 100', () => {
    const files = ['terraform/main.tf', '.github/workflows/ci.yml', 'src/app.ts'];
    const ranked = rankByRisk(files, { protectedPaths: ['terraform/**', '.github/workflows/**'] });
    assert.ok(ranked.indexOf('src/app.ts') > ranked.indexOf('terraform/main.tf'));
    assert.ok(ranked.indexOf('src/app.ts') > ranked.indexOf('.github/workflows/ci.yml'));
  });

  it('config files rank above generic src files', () => {
    const files = ['src/utils.ts', 'autopilot.config.yaml'];
    const ranked = rankByRisk(files);
    assert.equal(ranked[0], 'autopilot.config.yaml');
  });
});
