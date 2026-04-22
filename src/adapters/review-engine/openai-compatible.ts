import OpenAI from 'openai';
import { parseReviewOutput } from './parse-output.ts';
import { GuardrailError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';

const MAX_OUTPUT_TOKENS = 4096;

const SYSTEM_PROMPT_TEMPLATE = `You are a senior software architect reviewing code changes for quality, security, and correctness.

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
- CRITICAL: Blocks merge (security issues, data loss risks, broken contracts)
- WARNING: Should address before merging (logic errors, missing error handling, test gaps)
- NOTE: Improvement suggestion (style, performance, clarity)
- Maximum 10 findings, ranked by severity
- Be specific and constructive
- Reference the file and line when possible`;

export const openaiCompatibleAdapter: ReviewEngine = {
  name: 'openai-compatible',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const opts = (input.context as Record<string, unknown> | undefined) ?? {};

    // API key: options.apiKey → named env var → OPENAI_API_KEY
    const apiKeyEnv = (opts['apiKeyEnv'] as string | undefined) ?? 'OPENAI_API_KEY';
    const apiKey = (opts['apiKey'] as string | undefined) ?? process.env[apiKeyEnv] ?? 'ollama';

    const baseURL = (opts['baseUrl'] as string | undefined) ??
      process.env.OPENAI_BASE_URL ??
      undefined;

    const model = opts['model'] as string | undefined;
    if (!model) {
      throw new GuardrailError(
        'openai-compatible adapter requires options.model to be set in guardrail.config.yaml',
        { code: 'invalid_config', provider: 'openai-compatible' },
      );
    }

    const stack = input.context?.stack ?? 'A web application — stack details unspecified.';
    const gitCtx = input.context?.gitSummary ? `\n\nChange context: ${input.context.gitSummary}` : '';
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{STACK}', stack).replace('{GIT_CONTEXT}', gitCtx);
    const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Please review the following:\n\n---\n\n${input.content}` },
        ],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = /rate.limit|429/i.test(message);
      const isAuth = /unauthorized|401|invalid.api.key/i.test(message);
      throw new GuardrailError(`openai-compatible review call failed: ${message}`, {
        code: isAuth ? 'auth' : isRateLimit ? 'rate_limit' : 'transient_network',
        provider: 'openai-compatible',
        retryable: isRateLimit,
      });
    }

    const rawOutput = response.choices[0]?.message.content ?? '';
    return {
      findings: parseReviewOutput(rawOutput, 'openai-compatible'),
      rawOutput,
      usage: response.usage
        ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens }
        : undefined,
    };
  },
};

export default openaiCompatibleAdapter;
