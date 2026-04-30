import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('sdk-loader', () => {
  it('loadAnthropic returns a constructor', async () => {
    const { loadAnthropic } = await import('../src/adapters/sdk-loader.ts');
    const Anthropic = await loadAnthropic();
    assert.equal(typeof Anthropic, 'function');
  });

  it('loadOpenAI returns a constructor', async () => {
    const { loadOpenAI } = await import('../src/adapters/sdk-loader.ts');
    const OpenAI = await loadOpenAI();
    assert.equal(typeof OpenAI, 'function');
  });

  it('loadGoogleGenerativeAI returns a constructor', async () => {
    const { loadGoogleGenerativeAI } = await import('../src/adapters/sdk-loader.ts');
    const GoogleGenerativeAI = await loadGoogleGenerativeAI();
    assert.equal(typeof GoogleGenerativeAI, 'function');
  });

  it('isSdkInstalled returns true for installed SDK', async () => {
    const { isSdkInstalled } = await import('../src/adapters/sdk-loader.ts');
    assert.equal(await isSdkInstalled('openai'), true);
  });

  it('isSdkInstalled returns false for unknown package', async () => {
    const { isSdkInstalled } = await import('../src/adapters/sdk-loader.ts');
    assert.equal(await isSdkInstalled('@delegance/never-installed-sdk-xyz'), false);
  });
});
