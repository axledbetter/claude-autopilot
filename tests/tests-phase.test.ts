import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTestsPhase } from '../src/core/phases/tests.ts';

test('runTestsPhase skips when no testCommand', async () => {
  const r = await runTestsPhase({ touchedFiles: [], testCommand: null });
  assert.equal(r.status, 'skip');
  assert.equal(r.findings.length, 0);
});

test('runTestsPhase passes on successful command', async () => {
  const r = await runTestsPhase({ touchedFiles: [], testCommand: 'node --version' });
  assert.equal(r.status, 'pass');
});

test('runTestsPhase fails on bad command', async () => {
  const r = await runTestsPhase({ touchedFiles: [], testCommand: 'this-command-does-not-exist' });
  assert.equal(r.status, 'fail');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.severity, 'critical');
});
