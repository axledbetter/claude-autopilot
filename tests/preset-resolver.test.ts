import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreset } from '../src/core/config/preset-resolver.ts';
import { GuardrailError } from '../src/core/errors.ts';

test('resolvePreset throws for unknown preset', async () => {
  await assert.rejects(
    () => resolvePreset('does-not-exist'),
    (err: unknown) => {
      assert.ok(err instanceof GuardrailError);
      assert.equal(err.code, 'invalid_config');
      return true;
    }
  );
});

test('resolvePreset loads nextjs-supabase', async () => {
  const preset = await resolvePreset('nextjs-supabase');
  assert.equal(preset.config.configVersion, 1);
  assert.ok(preset.stack.length > 0);
});
