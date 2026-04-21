import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('claudeAdapter', () => {
  it('exports a ReviewEngine with required methods', async () => {
    const { claudeAdapter } = await import('../src/adapters/review-engine/claude.ts');
    assert.equal(typeof claudeAdapter.review, 'function');
    assert.equal(typeof claudeAdapter.estimateTokens, 'function');
    assert.equal(typeof claudeAdapter.getCapabilities, 'function');
    assert.equal(claudeAdapter.name, 'claude');
    assert.equal(claudeAdapter.apiVersion, '1.0.0');
  });

  it('estimateTokens returns a positive integer', async () => {
    const { claudeAdapter } = await import('../src/adapters/review-engine/claude.ts');
    const tokens = claudeAdapter.estimateTokens('hello world this is a test string');
    assert.ok(tokens > 0);
    assert.equal(tokens, Math.ceil('hello world this is a test string'.length / 3.5));
  });

  it('getCapabilities includes maxContextTokens >= 200000', async () => {
    const { claudeAdapter } = await import('../src/adapters/review-engine/claude.ts');
    const caps = claudeAdapter.getCapabilities();
    assert.ok((caps['maxContextTokens'] as number) >= 200000);
  });

  it('throws auth error when ANTHROPIC_API_KEY is missing', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { claudeAdapter } = await import('../src/adapters/review-engine/claude.ts');
    try {
      await assert.rejects(
        () => claudeAdapter.review({ content: 'test', kind: 'file-batch' }),
        (err: Error) => err.message.includes('ANTHROPIC_API_KEY'),
      );
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('autoAdapter', () => {
  it('exports a ReviewEngine with required methods', async () => {
    const { autoAdapter } = await import('../src/adapters/review-engine/auto.ts');
    assert.equal(typeof autoAdapter.review, 'function');
    assert.equal(typeof autoAdapter.estimateTokens, 'function');
    assert.equal(autoAdapter.name, 'auto');
  });

  it('throws auth error when neither API key is set', async () => {
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const savedOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { autoAdapter } = await import('../src/adapters/review-engine/auto.ts');
    try {
      await assert.rejects(
        () => autoAdapter.review({ content: 'test', kind: 'file-batch' }),
        (err: Error) => err.message.includes('No LLM API key'),
      );
    } finally {
      if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
      if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    }
  });
});

describe('adapter loader — claude and auto registration', () => {
  it('loads claude adapter by name', async () => {
    const { loadAdapter } = await import('../src/adapters/loader.ts');
    const adapter = await loadAdapter({ point: 'review-engine', ref: 'claude' });
    assert.equal(adapter.name, 'claude');
  });

  it('loads auto adapter by name', async () => {
    const { loadAdapter } = await import('../src/adapters/loader.ts');
    const adapter = await loadAdapter({ point: 'review-engine', ref: 'auto' });
    assert.equal(adapter.name, 'auto');
  });
});
