import Anthropic from '@anthropic-ai/sdk';
import { GuardrailError } from '../../core/errors.ts';
import { classifyError } from '../review-engine/prompt-builder.ts';
import type { CouncilAdapter, CouncilConsultResult } from './types.ts';

const SYSTEM_PROMPT = `You are a technical advisor reviewing a software design decision. Evaluate the provided context and question critically. Be direct and specific. Surface tradeoffs, risks, and your recommendation.`;
const MAX_OUTPUT_TOKENS = 2048;
// Default Opus 4.7 rates — env override for other models.
const COST_PER_M_INPUT = Number(process.env.CLAUDE_COST_INPUT_PER_M ?? 15.0);
const COST_PER_M_OUTPUT = Number(process.env.CLAUDE_COST_OUTPUT_PER_M ?? 75.0);

export function makeClaudeCouncilAdapter(model: string, label: string): CouncilAdapter {
  return {
    label,
    async consult(prompt: string, context: string): Promise<CouncilConsultResult> {
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
        const code = classifyError(message);
        throw new GuardrailError(`Claude council call failed: ${message}`, {
          code,
          provider: 'claude',
          retryable: code === 'rate_limit',
        });
      }
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('');
      const usage = response.usage ? {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        costUSD:
          (response.usage.input_tokens / 1_000_000) * COST_PER_M_INPUT +
          (response.usage.output_tokens / 1_000_000) * COST_PER_M_OUTPUT,
      } : undefined;
      return { text, usage };
    },
  };
}
