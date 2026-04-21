import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkApiVersionCompatibility } from '../src/adapters/base.ts';

test('checkApiVersionCompatibility accepts matching major', () => {
  assert.equal(checkApiVersionCompatibility('1.0.0'), true);
  assert.equal(checkApiVersionCompatibility('1.5.2'), true);
});

test('checkApiVersionCompatibility rejects mismatched major', () => {
  assert.equal(checkApiVersionCompatibility('0.9.0'), false);
  assert.equal(checkApiVersionCompatibility('2.0.0'), false);
});
