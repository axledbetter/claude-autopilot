import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Smoke test: runDoctor is exported and returns the right shape
describe('runDoctor', () => {
  it('exports runDoctor as a function', async () => {
    const mod = await import('../../src/cli/preflight.ts');
    assert.equal(typeof mod.runDoctor, 'function');
  });

  it('returns { blockers, warnings } with numeric values', async () => {
    const { runDoctor } = await import('../../src/cli/preflight.ts');
    const result = await runDoctor();
    assert.equal(typeof result.blockers, 'number');
    assert.equal(typeof result.warnings, 'number');
  });
});
