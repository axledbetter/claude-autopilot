import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCouncilConfig } from '../../src/core/council/config.ts';
import { GuardrailError } from '../../src/core/errors.ts';

const validRaw = {
  models: [
    { adapter: 'claude', model: 'claude-opus-4-7', label: 'Claude' },
    { adapter: 'openai', model: 'gpt-5.4', label: 'Codex' },
  ],
  synthesizer: { adapter: 'claude', model: 'claude-opus-4-7', label: 'Synthesizer' },
};

describe('parseCouncilConfig', () => {
  it('CC1: parses valid config and applies defaults', () => {
    const cfg = parseCouncilConfig(validRaw);
    assert.equal(cfg.timeoutMs, 30000);
    assert.equal(cfg.minSuccessfulResponses, 1);
    assert.equal(cfg.parallelInputMaxTokens, 8000);
    assert.equal(cfg.synthesisInputMaxTokens, 12000);
    assert.equal(cfg.models.length, 2);
    assert.equal(cfg.models[0]!.label, 'Claude');
    assert.equal(cfg.synthesizer.label, 'Synthesizer');
  });

  it('CC2: throws on fewer than 2 models', () => {
    assert.throws(
      () => parseCouncilConfig({
        models: [{ adapter: 'claude', model: 'x', label: 'A' }],
        synthesizer: { adapter: 'claude', model: 'x', label: 'S' },
      }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });

  it('CC3: throws on duplicate labels in models', () => {
    assert.throws(
      () => parseCouncilConfig({
        models: [
          { adapter: 'claude', model: 'x', label: 'Same' },
          { adapter: 'openai', model: 'y', label: 'Same' },
        ],
        synthesizer: { adapter: 'claude', model: 'x', label: 'S' },
      }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });

  it('CC4: throws on unknown adapter name', () => {
    assert.throws(
      () => parseCouncilConfig({
        models: [
          { adapter: 'unknown', model: 'x', label: 'A' },
          { adapter: 'claude', model: 'y', label: 'B' },
        ],
        synthesizer: { adapter: 'claude', model: 'y', label: 'S' },
      }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });

  it('CC4b: throws on unknown adapter name in synthesizer', () => {
    assert.throws(
      () => parseCouncilConfig({
        models: [
          { adapter: 'claude', model: 'x', label: 'A' },
          { adapter: 'openai', model: 'y', label: 'B' },
        ],
        synthesizer: { adapter: 'gemini', model: 'z', label: 'S' },
      }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });

  it('CC5: throws when min_successful_responses > models.length', () => {
    assert.throws(
      () => parseCouncilConfig({ ...validRaw, min_successful_responses: 5 }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });

  it('CC6: throws when timeout_ms < 5000', () => {
    assert.throws(
      () => parseCouncilConfig({ ...validRaw, timeout_ms: 100 }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });
});
