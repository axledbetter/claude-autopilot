import OpenAI from 'openai';
import { GuardrailError } from '../../core/errors.ts';
import { classifyError } from '../review-engine/prompt-builder.ts';
import type { CouncilAdapter } from './types.ts';

const SYSTEM_PROMPT = `You are a technical advisor reviewing a software design decision. Evaluate the provided context and question critically. Be direct and specific. Surface tradeoffs, risks, and your recommendation.`;
const MAX_OUTPUT_TOKENS = 2048;

// Models that ONLY work via the Responses API (not chat.completions).
// Codex variants and the o-series reasoning models all 404 on chat.completions.
// Without this branch, putting `gpt-5.3-codex` (the typical default) in
// council.models throws model_not_found, AND the synthesizer (also typically
// gpt-5.3-codex) fails the same way — so the whole council returns `partial`
// with no synthesis. That regression made the marketed multi-model differentiator
// unusable for any user who only had OPENAI_API_KEY.
function isResponsesOnlyModel(model: string): boolean {
  return /codex|^o[1-9]|^gpt-5\.3-/i.test(model);
}

export function makeOpenAICouncilAdapter(model: string, label: string): CouncilAdapter {
  return {
    label,
    async consult(prompt: string, context: string): Promise<string> {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new GuardrailError('OPENAI_API_KEY not set', { code: 'auth', provider: 'openai' });
      }
      const client = new OpenAI({ apiKey });
      const userInput = `## Context\n\n${context}\n\n## Question\n\n${prompt}`;
      try {
        if (isResponsesOnlyModel(model)) {
          const response = await client.responses.create({
            model,
            instructions: SYSTEM_PROMPT,
            input: userInput,
            max_output_tokens: MAX_OUTPUT_TOKENS,
          });
          return response.output_text ?? '';
        }
        const response = await client.chat.completions.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userInput },
          ],
        });
        return response.choices[0]?.message?.content ?? '';
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = classifyError(message);
        throw new GuardrailError(`OpenAI council call failed (model=${model}): ${message}`, {
          code,
          provider: 'openai',
          retryable: code === 'rate_limit',
        });
      }
    },
  };
}
