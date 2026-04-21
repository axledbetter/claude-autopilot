import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRedaction, DEFAULT_REDACTION_PATTERNS } from '../src/core/logging/redaction.ts';

test('applyRedaction masks OpenAI keys', () => {
  const out = applyRedaction('key=sk-abcdefghijklmnopqrstuvwxyz1234567890', DEFAULT_REDACTION_PATTERNS);
  assert.ok(!out.includes('sk-abc'));
  assert.ok(out.includes('[REDACTED]'));
});

test('applyRedaction leaves clean content alone', () => {
  const out = applyRedaction('hello world', DEFAULT_REDACTION_PATTERNS);
  assert.equal(out, 'hello world');
});

test('applyRedaction accepts custom patterns', () => {
  const out = applyRedaction('custom-secret-XYZ', ['custom-secret-[A-Z]+']);
  assert.ok(!out.includes('XYZ'));
});
