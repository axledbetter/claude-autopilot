import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as deployTypes from '../src/adapters/deploy/types.ts';
import { createDeployAdapter, GenericDeployAdapter, VercelDeployAdapter } from '../src/adapters/deploy/index.ts';

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
