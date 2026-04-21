import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadAdapter } from '../src/adapters/loader.ts';
import { AutopilotError } from '../src/core/errors.ts';

test('loadAdapter resolves built-in codex', async () => {
  const adapter = await loadAdapter({ point: 'review-engine', ref: 'codex' });
  assert.equal(adapter.name, 'codex');
});

test('loadAdapter resolves relative path', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-adapter-'));
  const fakePath = path.join(tmpDir, 'fake.ts');
  await fs.writeFile(fakePath, `
    export default {
      name: 'fake', apiVersion: '1.0.0',
      getCapabilities: () => ({}),
      review: async () => ({ findings: [], rawOutput: '' }),
      estimateTokens: () => 0,
    };
  `);
  const adapter = await loadAdapter({ point: 'review-engine', ref: fakePath, unsafeAllowLocalAdapters: true });
  assert.equal(adapter.name, 'fake');
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('loadAdapter rejects unknown built-in', async () => {
  await assert.rejects(
    () => loadAdapter({ point: 'review-engine', ref: 'does-not-exist' }),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'invalid_config');
      return true;
    }
  );
});

test('loadAdapter rejects mismatched apiVersion major', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-adapter-'));
  const fakePath = path.join(tmpDir, 'v2.ts');
  await fs.writeFile(fakePath, `
    export default {
      name: 'v2', apiVersion: '2.0.0',
      getCapabilities: () => ({}),
      review: async () => ({ findings: [], rawOutput: '' }),
      estimateTokens: () => 0,
    };
  `);
  await assert.rejects(
    () => loadAdapter({ point: 'review-engine', ref: fakePath, unsafeAllowLocalAdapters: true }),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'invalid_config');
      return true;
    }
  );
  await fs.rm(tmpDir, { recursive: true, force: true });
});
