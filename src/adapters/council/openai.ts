import { GuardrailError } from '../../core/errors.ts';
import { classifyError } from '../review-engine/prompt-builder.ts';
import type { CouncilAdapter, CouncilConsultResult } from './types.ts';
import { loadOpenAI } from '../sdk-loader.ts';

const SYSTEM_PROMPT = `You are a technical advisor reviewing a software design decision. Evaluate the provided context and question critically. Be direct and specific. Surface tradeoffs, risks, and your recommendation.`;
const MAX_OUTPUT_TOKENS = 2048;

// Models that ONLY work via the Responses API (not chat.completions).
// Codex variants and the o-series reasoning models all 404 on chat.completions.
// Without this branch, putting `gpt-5.3-codex` (the prior default) in
// council.models throws model_not_found, AND the synthesizer (also typically
// the same model) fails the same way — so the whole council returns `partial`
// with no synthesis. That regression made the marketed multi-model differentiator
// unusable for any user who only had OPENAI_API_KEY.
// gpt-5.5 (the new default, 2026-04-23) drops the `-codex` suffix and works
// via standard chat.completions, so it is intentionally NOT matched here.
function isResponsesOnlyModel(model: string): boolean {
  return /codex|^o[1-9]|^gpt-5\.3-/i.test(model);
}

// Per-million-token rates for gpt-5.5 (override via env for other models).
// Mirrors the review-engine codex adapter's pricing.
// gpt-5.5 pricing (2026-04-23 release): $5.00 input / $30.00 output per 1M.
const COST_PER_M_INPUT = Number(process.env.CODEX_COST_INPUT_PER_M ?? 5.0);
const COST_PER_M_OUTPUT = Number(process.env.CODEX_COST_OUTPUT_PER_M ?? 30.0);

export function makeOpenAICouncilAdapter(model: string, label: string): CouncilAdapter {
  return {
    label,
    async consult(prompt: string, context: string): Promise<CouncilConsultResult> {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new GuardrailError('OPENAI_API_KEY not set', { code: 'auth', provider: 'openai' });
      }
      const OpenAI = await loadOpenAI();
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
          const usage = response.usage ? {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens,
            costUSD:
              (response.usage.input_tokens / 1_000_000) * COST_PER_M_INPUT +
              (response.usage.output_tokens / 1_000_000) * COST_PER_M_OUTPUT,
          } : undefined;
          return { text: response.output_text ?? '', usage };
        }
        const response = await client.chat.completions.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userInput },
          ],
        });
        const usage = response.usage ? {
          input: response.usage.prompt_tokens,
          output: response.usage.completion_tokens,
          costUSD:
            (response.usage.prompt_tokens / 1_000_000) * COST_PER_M_INPUT +
            (response.usage.completion_tokens / 1_000_000) * COST_PER_M_OUTPUT,
        } : undefined;
        return { text: response.choices[0]?.message?.content ?? '', usage };
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
