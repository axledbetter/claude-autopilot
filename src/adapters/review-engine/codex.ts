import OpenAI from 'openai';
import { parseReviewOutput } from './parse-output.ts';
import { GuardrailError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';
import { buildSystemPrompt, classifyError } from './prompt-builder.ts';

const DEFAULT_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.3-codex';
const MAX_OUTPUT_TOKENS = 4096;

// Per-million-token rates for gpt-5.3-codex (override via env for other models).
// Computed client-side because the OpenAI Responses API returns token counts
// but no $-cost field. Without this, every codex run logged costUSD=0 even
// though tokens were tracked correctly.
const COST_PER_M_INPUT = Number(process.env.CODEX_COST_INPUT_PER_M ?? 1.25);
const COST_PER_M_OUTPUT = Number(process.env.CODEX_COST_OUTPUT_PER_M ?? 10.0);

const SYSTEM_PROMPT_TEMPLATE = `You are a senior software architect providing feedback on designs, proposals, and ideas.

The codebase context:
{STACK}{GIT_CONTEXT}{DESIGN_SCHEMA}

Provide structured feedback in exactly this format:

## Review Summary
One paragraph overall assessment.

## Findings

For each finding, use this format:
### [CRITICAL|WARNING|NOTE] <short title>
<explanation>
**Suggestion:** <actionable fix>

Rules:
- CRITICAL: Blocks implementation
- WARNING: Should address before implementing
- NOTE: Improvement suggestion
- Maximum 10 findings, ranked by severity
- Be specific and constructive`;

export const codexAdapter: ReviewEngine = {
  name: 'codex',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new GuardrailError('OPENAI_API_KEY not set', { code: 'auth', provider: 'codex' });
    }
    const systemPrompt = buildSystemPrompt(input, SYSTEM_PROMPT_TEMPLATE);

    const client = new OpenAI({ apiKey });
    let response;
    try {
      response = await client.responses.create({
        model: DEFAULT_MODEL,
        instructions: systemPrompt,
        input: `Please review the following:\n\n---\n\n${input.content}`,
        max_output_tokens: MAX_OUTPUT_TOKENS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyError(message);
      throw new GuardrailError(`Codex review call failed: ${message}`, {
        code,
        provider: 'codex',
        retryable: code === 'rate_limit',
      });
    }

    const rawOutput = response.output_text ?? '';
    const costUSD = response.usage
      ? (response.usage.input_tokens / 1_000_000) * COST_PER_M_INPUT +
        (response.usage.output_tokens / 1_000_000) * COST_PER_M_OUTPUT
      : undefined;
    return {
      findings: parseReviewOutput(rawOutput, 'codex'),
      rawOutput,
      usage: response.usage
        ? { input: response.usage.input_tokens, output: response.usage.output_tokens, costUSD }
        : undefined,
    };
  },
};

export default codexAdapter;
