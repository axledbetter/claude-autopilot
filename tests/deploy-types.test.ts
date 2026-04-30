import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as deployTypes from '../src/adapters/deploy/types.ts';
import { createDeployAdapter, GenericDeployAdapter, VercelDeployAdapter } from '../src/adapters/deploy/index.ts';
import type {
  DeployAdapter,
  DeployStreamLogsInput,
  DeployLogLine,
  DeployInput,
} from '../src/adapters/deploy/types.ts';

describe('deploy adapter — types module', () => {
  it('module is importable and exposes a barrel surface', () => {
    // The types module is purely declarative — runtime exports an empty
    // namespace. Importing without a throw is the contract we care about.
    assert.equal(typeof deployTypes, 'object');
  });

  it('barrel exports the adapter classes and factory', () => {
    assert.equal(typeof createDeployAdapter, 'function');
    assert.equal(typeof VercelDeployAdapter, 'function');
    assert.equal(typeof GenericDeployAdapter, 'function');
  });
});

describe('DeployAdapter Phase 2 surface', () => {
  it('exports DeployStreamLogsInput and DeployLogLine with expected shape', () => {
    const input: DeployStreamLogsInput = { deployId: 'dpl_x' };
    const line: DeployLogLine = { timestamp: 1, text: 'hello' };
    assert.equal(input.deployId, 'dpl_x');
    assert.equal(line.text, 'hello');
  });

  it('streamLogs is optional on DeployAdapter (omitting compiles)', () => {
    const noStream: DeployAdapter = {
      name: 'noop',
      deploy: async () => ({ status: 'pass', durationMs: 0 }),
    };
    assert.equal(noStream.streamLogs, undefined);
  });

  it('onDeployStart is an optional callback on DeployInput', () => {
    let captured: string | undefined;
    const input: DeployInput = { onDeployStart: (id) => { captured = id; } };
    input.onDeployStart?.('dpl_test');
    assert.equal(captured, 'dpl_test');
  });
});
