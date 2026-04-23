import Anthropic from '@anthropic-ai/sdk';
import { GuardrailError } from '../../core/errors.ts';
import type { CouncilAdapter } from './types.ts';

const SYSTEM_PROMPT = `You are a technical advisor reviewing a software design decision. Evaluate the provided context and question critically. Be direct and specific. Surface tradeoffs, risks, and your recommendation.`;
const MAX_OUTPUT_TOKENS = 2048;

export function makeClaudeCouncilAdapter(model: string, label: string): CouncilAdapter {
  return {
    label,
    async consult(prompt: string, context: string): Promise<string> {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new GuardrailError('ANTHROPIC_API_KEY not set', { code: 'auth', provider: 'claude' });
      }
      const client = new Anthropic({ apiKey });
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `## Context\n\n${context}\n\n## Question\n\n${prompt}` }],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new GuardrailError(`Claude council call failed: ${message}`, {
          code: 'transient_network',
          provider: 'claude',
        });
      }
      return response.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('');
    },
  };
}
