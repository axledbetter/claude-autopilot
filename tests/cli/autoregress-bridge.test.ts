import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoregressArgs } from '../../src/cli/autoregress-bridge.ts';

describe('buildAutoregressArgs', () => {
  it('passes mode and flags through unchanged', () => {
    const result = buildAutoregressArgs(['run', '--all']);
    assert.deepEqual(result, ['run', '--all']);
  });

  it('passes generate --files through unchanged', () => {
    const result = buildAutoregressArgs(['generate', '--files', 'src/foo.ts,src/bar.ts']);
    assert.deepEqual(result, ['generate', '--files', 'src/foo.ts,src/bar.ts']);
  });

  it('defaults to run when no mode provided', () => {
    const result = buildAutoregressArgs([]);
    assert.deepEqual(result, ['run']);
  });

  it('passes diff and update modes through', () => {
    assert.deepEqual(buildAutoregressArgs(['diff', '--snapshot', 'sarif']), ['diff', '--snapshot', 'sarif']);
    assert.deepEqual(buildAutoregressArgs(['update']), ['update']);
  });
});
