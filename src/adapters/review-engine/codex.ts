import OpenAI from 'openai';
import { parseReviewOutput } from './parse-output.ts';
import { AutopilotError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';

const DEFAULT_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.3-codex';
const MAX_OUTPUT_TOKENS = 4096;

const SYSTEM_PROMPT_TEMPLATE = `You are a senior software architect providing feedback on designs, proposals, and ideas.

The codebase context:
{STACK}{GIT_CONTEXT}

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
      throw new AutopilotError('OPENAI_API_KEY not set', { code: 'auth', provider: 'codex' });
    }
    const stack = input.context?.stack ?? 'A web application — stack details unspecified.';
    const gitCtx = input.context?.gitSummary ? `\n\nChange context: ${input.context.gitSummary}` : '';
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{STACK}', stack).replace('{GIT_CONTEXT}', gitCtx);

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
      const isRateLimit = /rate.limit|429/i.test(message);
      const isAuth = /unauthorized|401|invalid.api.key/i.test(message);
      throw new AutopilotError(`Codex review call failed: ${message}`, {
        code: isAuth ? 'auth' : isRateLimit ? 'rate_limit' : 'transient_network',
        provider: 'codex',
        retryable: isRateLimit,
      });
    }

    const rawOutput = response.output_text ?? '';
    return {
      findings: parseReviewOutput(rawOutput, 'codex'),
      rawOutput,
      usage: response.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : undefined,
    };
  },
};

export default codexAdapter;
