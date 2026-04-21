import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/core/config/loader.ts';
import { AutopilotError } from '../src/core/errors.ts';

test('loadConfig parses valid YAML', async () => {
  const config = await loadConfig('tests/fixtures/configs/valid-nextjs-supabase.yaml');
  assert.equal(config.configVersion, 1);
  assert.equal(config.preset, 'nextjs-supabase');
  assert.equal(config.thresholds?.bugbotAutoFix, 85);
});

test('loadConfig rejects missing configVersion', async () => {
  await assert.rejects(
    () => loadConfig('tests/fixtures/configs/invalid-missing-required.yaml'),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'invalid_config');
      return true;
    }
  );
});

test('loadConfig throws user_input on missing file', async () => {
  await assert.rejects(
    () => loadConfig('tests/fixtures/configs/does-not-exist.yaml'),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'user_input');
      return true;
    }
  );
});
