import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';
import { GuardrailError } from '../../core/errors.ts';
import { detectProviderUsage, dominantProvider, type Provider } from '../../core/detect/provider-usage.ts';

interface AvailableProvider {
  provider: Provider;
  load: () => Promise<ReviewEngine>;
}

function buildGroqAdapter(base: ReviewEngine): ReviewEngine {
  return {
    ...base,
    name: 'auto',
    review(input: ReviewInput) {
      return base.review({
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

function getAvailableProviders(): AvailableProvider[] {
  const available: AvailableProvider[] = [];
  if (process.env.ANTHROPIC_API_KEY) {
    available.push({ provider: 'anthropic', load: async () => (await import('./claude.ts')).claudeAdapter });
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    available.push({ provider: 'gemini', load: async () => (await import('./gemini.ts')).geminiAdapter });
  }
  if (process.env.OPENAI_API_KEY) {
    available.push({ provider: 'openai', load: async () => (await import('./codex.ts')).codexAdapter });
  }
  if (process.env.GROQ_API_KEY) {
    available.push({
      provider: 'groq',
      load: async () => buildGroqAdapter((await import('./openai-compatible.ts')).openaiCompatibleAdapter),
    });
  }
  return available;
}

async function resolveAdapter(cwd: string): Promise<ReviewEngine> {
  const available = getAvailableProviders();

  if (available.length === 0) {
    throw new GuardrailError(
      'No LLM API key found. Set one of: ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, GROQ_API_KEY',
      { code: 'auth', provider: 'auto' },
    );
  }

  // Single provider — no need to scan
  if (available.length === 1) return available[0]!.load();

  // Multiple keys present — prefer the provider most referenced in source code
  const counts = detectProviderUsage(cwd);
  const dominant = dominantProvider(counts);
  if (dominant) {
    const match = available.find(p => p.provider === dominant);
    if (match) return match.load();
  }

  // Fallback to first available (env-key priority order)
  return available[0]!.load();
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
    const cwd = (input.context as Record<string, unknown> | undefined)?.['cwd'] as string | undefined
      ?? process.cwd();
    const adapter = await resolveAdapter(cwd);
    return adapter.review(input);
  },
};

export default autoAdapter;
