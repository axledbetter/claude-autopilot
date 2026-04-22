import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';
import { AutopilotError } from '../../core/errors.ts';

// Priority order for key detection
async function resolveAdapter(): Promise<ReviewEngine> {
  if (process.env.ANTHROPIC_API_KEY) {
    const { claudeAdapter } = await import('./claude.ts');
    return claudeAdapter;
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    const { geminiAdapter } = await import('./gemini.ts');
    return geminiAdapter;
  }
  if (process.env.OPENAI_API_KEY) {
    const { codexAdapter } = await import('./codex.ts');
    return codexAdapter;
  }
  if (process.env.GROQ_API_KEY) {
    const { openaiCompatibleAdapter } = await import('./openai-compatible.ts');
    // Wrap with Groq config injected into review() context
    return {
      ...openaiCompatibleAdapter,
      name: 'auto',
      review(input: ReviewInput) {
        return openaiCompatibleAdapter.review({
          ...input,
          context: {
            ...input.context,
            model: 'llama-3.3-70b-versatile',
            baseUrl: 'https://api.groq.com/openai/v1',
            apiKeyEnv: 'GROQ_API_KEY',
          } as typeof input.context,
        });
      },
    };
  }
  throw new AutopilotError(
    'No LLM API key found. Set one of: ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, GROQ_API_KEY',
    { code: 'auth', provider: 'auto' },
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
