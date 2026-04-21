import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStaticRulesPhase } from '../src/core/phases/static-rules.ts';
import {
  fakeCleanRule, fakeCriticalRule, fakeAutofixingRule, fakeProtectedAutofixRule,
} from './fixtures/adapters/fake-rules.ts';

test('clean diff returns pass', async () => {
  const r = await runStaticRulesPhase({ touchedFiles: ['src/x.ts'], rules: [fakeCleanRule] });
  assert.equal(r.status, 'pass');
  assert.equal(r.findings.length, 0);
});

test('critical finding returns fail', async () => {
  const r = await runStaticRulesPhase({ touchedFiles: ['src/x.ts'], rules: [fakeCriticalRule] });
  assert.equal(r.status, 'fail');
  assert.equal(r.findings.length, 1);
});

test('autofix applies and marks fix attempt', async () => {
  const r = await runStaticRulesPhase({ touchedFiles: ['src/x.ts'], rules: [fakeAutofixingRule] });
  assert.equal(r.fixAttempts.length, 1);
  assert.equal(r.fixAttempts[0]!.status, 'fixed');
});

test('autofix skipped on protected path', async () => {
  const r = await runStaticRulesPhase({ touchedFiles: ['src/x.ts'], rules: [fakeProtectedAutofixRule] });
  assert.equal(r.fixAttempts.length, 1);
  assert.equal(r.fixAttempts[0]!.status, 'skipped');
  assert.equal(r.fixAttempts[0]!.notes, 'protected path');
});
