import OpenAI from 'openai';
import { GuardrailError } from '../../core/errors.ts';
import type { CouncilAdapter } from './types.ts';

const SYSTEM_PROMPT = `You are a technical advisor reviewing a software design decision. Evaluate the provided context and question critically. Be direct and specific. Surface tradeoffs, risks, and your recommendation.`;
const MAX_OUTPUT_TOKENS = 2048;

export function makeOpenAICouncilAdapter(model: string, label: string): CouncilAdapter {
  return {
    label,
    async consult(prompt: string, context: string): Promise<string> {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new GuardrailError('OPENAI_API_KEY not set', { code: 'auth', provider: 'openai' });
      }
      const client = new OpenAI({ apiKey });
      let response: OpenAI.ChatCompletion;
      try {
        response = await client.chat.completions.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `## Context\n\n${context}\n\n## Question\n\n${prompt}` },
          ],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new GuardrailError(`OpenAI council call failed: ${message}`, {
          code: 'transient_network',
          provider: 'openai',
        });
      }
      return response.choices[0]?.message?.content ?? '';
    },
  };
}
