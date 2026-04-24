import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LLM_KEY_NAMES, LLM_KEY_HINTS, detectLLMKey } from '../src/core/detect/llm-key.ts';

describe('LLM key detection', () => {
  // Prevents the asymmetry that caused "No LLM API key" / "detected" contradictions
  // across doctor/setup/scan/run before unification.
  it('LLM_KEY_HINTS covers every LLM_KEY_NAMES entry', () => {
    const hintNames = new Set(LLM_KEY_HINTS.map(h => h.name));
    for (const name of LLM_KEY_NAMES) {
      assert.ok(hintNames.has(name), `LLM_KEY_HINTS missing entry for ${name} — every recognized key needs a user-facing hint`);
    }
  });

  it('detectLLMKey returns hasKey=false with empty env', () => {
    // Clear any LLM keys that might be set
    const original: Record<string, string | undefined> = {};
    for (const name of LLM_KEY_NAMES) {
      original[name] = process.env[name];
      delete process.env[name];
    }
    try {
      const result = detectLLMKey();
      assert.equal(result.hasKey, false);
      assert.equal(result.preferred, null);
      assert.deepEqual(result.detected, []);
    } finally {
      for (const [k, v] of Object.entries(original)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  });

  it('detectLLMKey picks preferred per LLM_KEY_NAMES order', () => {
    const original: Record<string, string | undefined> = {};
    for (const name of LLM_KEY_NAMES) {
      original[name] = process.env[name];
      delete process.env[name];
    }
    try {
      process.env.GROQ_API_KEY = 'gsk_test';
      process.env.OPENAI_API_KEY = 'sk-test';
      const result = detectLLMKey();
      assert.equal(result.hasKey, true);
      // OPENAI comes before GROQ in LLM_KEY_NAMES
      assert.equal(result.preferred, 'OPENAI_API_KEY');
      assert.deepEqual(result.detected, ['OPENAI_API_KEY', 'GROQ_API_KEY']);
    } finally {
      for (const [k, v] of Object.entries(original)) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
    }
  });

  it('detectLLMKey honors extraEnv (for env-file fallback)', () => {
    const original: Record<string, string | undefined> = {};
    for (const name of LLM_KEY_NAMES) {
      original[name] = process.env[name];
      delete process.env[name];
    }
    try {
      const result = detectLLMKey({ extraEnv: { GEMINI_API_KEY: 'g-test' } });
      assert.equal(result.hasKey, true);
      assert.equal(result.preferred, 'GEMINI_API_KEY');
    } finally {
      for (const [k, v] of Object.entries(original)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  });
});
