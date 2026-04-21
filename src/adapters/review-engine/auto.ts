import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';
import { AutopilotError } from '../../core/errors.ts';

// Priority order: ANTHROPIC_API_KEY → claude, OPENAI_API_KEY → codex
async function resolveAdapter(): Promise<ReviewEngine> {
  if (process.env.ANTHROPIC_API_KEY) {
    const { claudeAdapter } = await import('./claude.ts');
    return claudeAdapter;
  }
  if (process.env.OPENAI_API_KEY) {
    const { codexAdapter } = await import('./codex.ts');
    return codexAdapter;
  }
  throw new AutopilotError(
    'No LLM API key found — set ANTHROPIC_API_KEY (recommended) or OPENAI_API_KEY to enable review',
    { code: 'auth', provider: 'auto' }
  );
}

export const autoAdapter: ReviewEngine = {
  name: 'auto',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: false, maxContextTokens: 200000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 3.5);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const adapter = await resolveAdapter();
    return adapter.review(input);
  },
};

export default autoAdapter;
