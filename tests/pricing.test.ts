import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PRICING, getModelPricing } from '../src/adapters/pricing.ts';

describe('MODEL_PRICING', () => {
  it('includes the gpt-5.5 default at $5.00 input / $30.00 output per 1M', () => {
    const p = getModelPricing('gpt-5.5');
    assert.ok(p, 'gpt-5.5 must be in MODEL_PRICING');
    assert.equal(p!.inputPer1M, 5.0);
    assert.equal(p!.outputPer1M, 30.0);
  });

  it('keeps the prior gpt-5.4 entry for back-compat with pinned configs', () => {
    const p = getModelPricing('gpt-5.4');
    assert.ok(p, 'gpt-5.4 must remain in MODEL_PRICING for back-compat');
    assert.equal(p!.inputPer1M, 2.5);
    assert.equal(p!.outputPer1M, 15.0);
  });

  it('keeps the legacy gpt-5.3-codex entry for back-compat with pinned configs', () => {
    const p = getModelPricing('gpt-5.3-codex');
    assert.ok(p, 'gpt-5.3-codex must remain in MODEL_PRICING for back-compat');
    assert.equal(p!.inputPer1M, 1.25);
    assert.equal(p!.outputPer1M, 10.0);
  });

  it('returns undefined for unknown models (callers fall back to env defaults)', () => {
    assert.equal(getModelPricing('not-a-real-model'), undefined);
  });

  it('every entry has the full ModelPricing shape (no missing fields)', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      assert.equal(typeof pricing.inputPer1M, 'number', `${model}.inputPer1M`);
      assert.equal(typeof pricing.outputPer1M, 'number', `${model}.outputPer1M`);
      // cachedInputPer1M is `number | null`
      assert.ok(
        pricing.cachedInputPer1M === null || typeof pricing.cachedInputPer1M === 'number',
        `${model}.cachedInputPer1M`
      );
    }
  });
});
