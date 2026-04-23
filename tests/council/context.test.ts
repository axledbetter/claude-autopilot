import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { windowContext } from '../../src/core/council/context.ts';

describe('windowContext', () => {
  it('C1: returns text unchanged when under budget', () => {
    const text = 'short doc';
    // 9 chars / 4 ≈ 3 tokens — well under 10000 budget
    assert.equal(windowContext(text, 10000), text);
  });

  it('C2: truncates from top when over budget', () => {
    // 2000 chars / 4 = 500 tokens — over budget of 250 tokens (1000 chars budget)
    const text = 'A'.repeat(1000) + 'B'.repeat(1000);
    const result = windowContext(text, 250);
    assert.ok(result.includes('<!-- [council: truncated'));
    // Keeps most recent content (B's), drops oldest (A's)
    assert.ok(result.endsWith('B'.repeat(1000)));
    assert.ok(!result.startsWith('A'));
  });

  it('C3: exactly at budget — no truncation', () => {
    // 400 chars / 4 = 100 tokens exactly
    const text = 'X'.repeat(400);
    assert.equal(windowContext(text, 100), text);
  });
});
