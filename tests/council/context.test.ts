import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { windowContext } from '../../src/core/council/context.ts';

describe('windowContext', () => {
  it('C1: returns text unchanged when under budget', () => {
    const text = 'short doc';
    // 9 chars / 4 ≈ 3 tokens — well under 10000 budget
    assert.equal(windowContext(text, 10000), text);
  });

  it('C2: truncates from top when over budget, output stays within budget', () => {
    // 2000 chars / 4 = 500 tokens — over budget of 250 tokens (1000 chars budget)
    const text = 'A'.repeat(1000) + 'B'.repeat(1000);
    const result = windowContext(text, 250);
    assert.ok(result.includes('<!-- [council: truncated'));
    // Marker reserves budget so final output fits within maxTokens (4 chars/token)
    assert.ok(result.length <= 250 * 4, `output exceeded budget: ${result.length} chars`);
    // Keeps most recent content — output always ends with B's (the tail)
    assert.ok(result.endsWith('B'), `expected tail B, got: ${result.slice(-10)}`);
    // Oldest content (the A's) is dropped — output should not contain leading A's after marker
    assert.ok(!result.includes('AAAA'.repeat(10)), 'expected oldest A chunk dropped');
  });

  it('C3: exactly at budget — no truncation', () => {
    // 400 chars / 4 = 100 tokens exactly
    const text = 'X'.repeat(400);
    assert.equal(windowContext(text, 100), text);
  });
});
