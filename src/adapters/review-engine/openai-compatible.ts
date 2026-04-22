import OpenAI from 'openai';
import type { Finding } from '../../core/findings/types.ts';
import { AutopilotError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';

const MAX_OUTPUT_TOKENS = 4096;

const SYSTEM_PROMPT_TEMPLATE = `You are a senior software architect reviewing code changes for quality, security, and correctness.

The codebase context:
{STACK}

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
      throw new AutopilotError(
        'openai-compatible adapter requires options.model to be set in autopilot.config.yaml',
        { code: 'invalid_config', provider: 'openai-compatible' },
      );
    }

    const stack = input.context?.stack ?? 'A web application — stack details unspecified.';
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{STACK}', stack);
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
      throw new AutopilotError(`openai-compatible review call failed: ${message}`, {
        code: isAuth ? 'auth' : isRateLimit ? 'rate_limit' : 'transient_network',
        provider: 'openai-compatible',
        retryable: isRateLimit,
      });
    }

    const rawOutput = response.choices[0]?.message.content ?? '';
    return {
      findings: parseOutput(rawOutput),
      rawOutput,
      usage: response.usage
        ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens }
        : undefined,
    };
  },
};

export default openaiCompatibleAdapter;

function parseOutput(output: string): Finding[] {
  const findings: Finding[] = [];
  const regex = /### \[(CRITICAL|WARNING|NOTE)\]\s*(.+?)(?=\n### \[|## Review Summary|$)/gs;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const severity = match[1]!.toLowerCase() as Finding['severity'];
    const body = match[2]!.trim();
    const titleEnd = body.indexOf('\n');
    const title = (titleEnd > 0 ? body.slice(0, titleEnd) : body).trim();
    const suggestion = body.match(/\*\*Suggestion:\*\*\s*(.+)/s)?.[1]?.trim();
    findings.push({
      id: `openai-compatible-${findings.length}`,
      source: 'review-engine',
      severity,
      category: 'openai-compatible-review',
      file: '<unspecified>',
      message: title,
      suggestion,
      protectedPath: false,
      createdAt: new Date().toISOString(),
    });
  }
  return findings;
}
