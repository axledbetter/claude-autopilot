import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRunState, loadRunState, updateStepStatus } from '../src/core/runtime/state.ts';

test('createRunState writes initial state with all steps pending', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-state-'));
  const state = await createRunState({ runId: 'r1', topic: 't', runsDir: tmpDir });
  assert.equal(state.runId, 'r1');
  for (const step of Object.values(state.steps)) assert.equal(step.status, 'pending');
  const loaded = await loadRunState('r1', tmpDir);
  assert.deepEqual(loaded, state);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('updateStepStatus persists completion', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-state-'));
  await createRunState({ runId: 'r2', topic: 'x', runsDir: tmpDir });
  await updateStepStatus({
    runId: 'r2', runsDir: tmpDir, step: 'plan',
    update: { status: 'completed', idempotencyKey: 'abc', artifact: 'docs/plans/x.md' },
  });
  const reloaded = await loadRunState('r2', tmpDir);
  assert.equal(reloaded.steps.plan.status, 'completed');
  assert.equal(reloaded.steps.plan.idempotencyKey, 'abc');
  await fs.rm(tmpDir, { recursive: true, force: true });
});
