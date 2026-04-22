import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardrailError, type ErrorCode } from '../src/core/errors.ts';

test('GuardrailError preserves code, retryable, provider, step, details', () => {
  const err = new GuardrailError('rate limit hit', {
    code: 'rate_limit', retryable: true, provider: 'codex', step: 'review',
    details: { retryAfter: 30 },
  });
  assert.equal(err.message, 'rate limit hit');
  assert.equal(err.code, 'rate_limit');
  assert.equal(err.retryable, true);
  assert.equal(err.provider, 'codex');
  assert.equal(err.step, 'review');
  assert.deepEqual(err.details, { retryAfter: 30 });
  assert.ok(err instanceof Error);
});

test('GuardrailError defaults retryable from code', () => {
  const nonRetryable: ErrorCode[] = ['auth', 'invalid_config', 'adapter_bug', 'user_input', 'budget_exceeded', 'concurrency_lock', 'superseded'];
  for (const code of nonRetryable) {
    const e = new GuardrailError('x', { code });
    assert.equal(e.retryable, false);
  }
  const retryable: ErrorCode[] = ['rate_limit', 'transient_network'];
  for (const code of retryable) {
    const e = new GuardrailError('x', { code });
    assert.equal(e.retryable, true);
  }
});
