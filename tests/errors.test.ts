import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutopilotError, type ErrorCode } from '../src/core/errors.ts';

test('AutopilotError preserves code, retryable, provider, step, details', () => {
  const err = new AutopilotError('rate limit hit', {
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

test('AutopilotError defaults retryable from code', () => {
  const nonRetryable: ErrorCode[] = ['auth', 'invalid_config', 'adapter_bug', 'user_input', 'budget_exceeded', 'concurrency_lock', 'superseded'];
  for (const code of nonRetryable) {
    const e = new AutopilotError('x', { code });
    assert.equal(e.retryable, false);
  }
  const retryable: ErrorCode[] = ['rate_limit', 'transient_network'];
  for (const code of retryable) {
    const e = new AutopilotError('x', { code });
    assert.equal(e.retryable, true);
  }
});
