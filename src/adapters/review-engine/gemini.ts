import { GoogleGenerativeAI } from '@google/generative-ai';
import { parseReviewOutput } from './parse-output.ts';
import { AutopilotError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';

const DEFAULT_MODEL = 'gemini-2.5-pro-preview-05-06';
const MAX_OUTPUT_TOKENS = 4096;

// Cost per million tokens (USD) — gemini-2.5-pro pricing (<200k context)
const COST_PER_M_INPUT = 1.25;
const COST_PER_M_OUTPUT = 10.0;

const PROMPT_TEMPLATE = `You are a senior software architect reviewing code changes for quality, security, and correctness.

The codebase context:
{STACK}{GIT_CONTEXT}

Please review the following:

---

{CONTENT}

---

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

export const geminiAdapter: ReviewEngine = {
  name: 'gemini',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: false, maxContextTokens: 1000000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new AutopilotError('GEMINI_API_KEY (or GOOGLE_API_KEY) not set', { code: 'auth', provider: 'gemini' });
    }

    const model = (input.context as Record<string, unknown> | undefined)?.['model'] as string | undefined ?? DEFAULT_MODEL;
    const stack = input.context?.stack ?? 'A web application — stack details unspecified.';
    const gitCtx = input.context?.gitSummary ? `\n\nChange context: ${input.context.gitSummary}` : '';
    const prompt = PROMPT_TEMPLATE.replace('{STACK}', stack).replace('{GIT_CONTEXT}', gitCtx).replace('{CONTENT}', input.content);

    const genAI = new GoogleGenerativeAI(apiKey);
    const genModel = genAI.getGenerativeModel({
      model,
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });

    let result: Awaited<ReturnType<typeof genModel.generateContent>>;
    try {
      result = await genModel.generateContent(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = /rate.limit|429|quota/i.test(message);
      const isAuth = /api.key|unauthorized|403/i.test(message);
      throw new AutopilotError(`Gemini review call failed: ${message}`, {
        code: isAuth ? 'auth' : isRateLimit ? 'rate_limit' : 'transient_network',
        provider: 'gemini',
        retryable: isRateLimit,
      });
    }

    const rawOutput = result.response.text();
    const usage = result.response.usageMetadata;
    const costUSD = usage
      ? (usage.promptTokenCount / 1_000_000) * COST_PER_M_INPUT +
        (usage.candidatesTokenCount / 1_000_000) * COST_PER_M_OUTPUT
      : undefined;

    return {
      findings: parseReviewOutput(rawOutput, 'gemini'),
      rawOutput,
      usage: usage
        ? { input: usage.promptTokenCount, output: usage.candidatesTokenCount, costUSD }
        : undefined,
    };
  },
};

export default geminiAdapter;
