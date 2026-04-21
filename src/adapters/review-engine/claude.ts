import Anthropic from '@anthropic-ai/sdk';
import type { Finding } from '../../core/findings/types.ts';
import { AutopilotError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 4096;

// Cost per million tokens (USD) — sonnet-4-6 pricing
const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;

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

export const claudeAdapter: ReviewEngine = {
  name: 'claude',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: false, maxContextTokens: 200000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 3.5);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AutopilotError('ANTHROPIC_API_KEY not set', { code: 'auth', provider: 'claude' });
    }

    const model = (input.context as Record<string, unknown> | undefined)?.['model'] as string | undefined ?? DEFAULT_MODEL;
    const stack = input.context?.stack ?? 'A web application — stack details unspecified.';
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{STACK}', stack);

    const client = new Anthropic({ apiKey });
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Please review the following:\n\n---\n\n${input.content}` }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = /rate.limit|429|overloaded/i.test(message);
      const isAuth = /unauthorized|401|invalid.api.key|authentication/i.test(message);
      throw new AutopilotError(`Claude review call failed: ${message}`, {
        code: isAuth ? 'auth' : isRateLimit ? 'rate_limit' : 'transient_network',
        provider: 'claude',
        retryable: isRateLimit,
      });
    }

    const rawOutput = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('');

    const costUSD = response.usage
      ? (response.usage.input_tokens / 1_000_000) * COST_PER_M_INPUT +
        (response.usage.output_tokens / 1_000_000) * COST_PER_M_OUTPUT
      : undefined;

    return {
      findings: parseClaudeOutput(rawOutput),
      rawOutput,
      usage: response.usage
        ? { input: response.usage.input_tokens, output: response.usage.output_tokens, costUSD }
        : undefined,
    };
  },
};

export default claudeAdapter;

function parseClaudeOutput(output: string): Finding[] {
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
      id: `claude-${findings.length}`,
      source: 'review-engine',
      severity,
      category: 'claude-review',
      file: '<unspecified>',
      message: title,
      suggestion,
      protectedPath: false,
      createdAt: new Date().toISOString(),
    });
  }
  return findings;
}
