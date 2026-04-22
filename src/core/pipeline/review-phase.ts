import type { ReviewEngine } from '../../adapters/review-engine/types.ts';
import type { Finding } from '../findings/types.ts';
import type { AutopilotConfig } from '../config/types.ts';
import { buildReviewChunks } from '../chunking/index.ts';

export interface ReviewPhaseResult {
  phase: 'review';
  status: 'pass' | 'warn' | 'fail' | 'skip';
  findings: Finding[];
  costUSD?: number;
  usage?: { input: number; output: number };
  durationMs: number;
}

export interface ReviewPhaseInput {
  touchedFiles: string[];
  engine: ReviewEngine;
  config: AutopilotConfig;
  cwd?: string;
  gitSummary?: string;
  budgetRemainingUSD?: number;
}

export async function runReviewPhase(input: ReviewPhaseInput): Promise<ReviewPhaseResult> {
  const start = Date.now();

  if (input.touchedFiles.length === 0) {
    return { phase: 'review', status: 'skip', findings: [], durationMs: Date.now() - start };
  }

  const chunks = await buildReviewChunks({
    touchedFiles: input.touchedFiles,
    strategy: input.config.reviewStrategy ?? 'auto',
    chunking: input.config.chunking,
    engine: input.engine,
    cwd: input.cwd,
    protectedPaths: input.config.protectedPaths,
  });

  const allFindings: Finding[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUSD = 0;
  let budgetExceeded = false;

  for (const chunk of chunks) {
    if (input.budgetRemainingUSD !== undefined && totalCostUSD >= input.budgetRemainingUSD) {
      budgetExceeded = true;
      break;
    }
    const output = await input.engine.review({
      content: chunk.content,
      kind: chunk.kind,
      context: { stack: input.config.stack, cwd: input.cwd, gitSummary: input.gitSummary },
    });
    allFindings.push(...output.findings);
    if (output.usage) {
      totalInputTokens += output.usage.input;
      totalOutputTokens += output.usage.output;
      if (output.usage.costUSD !== undefined) totalCostUSD += output.usage.costUSD;
    }
  }

  if (budgetExceeded) {
    allFindings.push({
      id: 'budget-exceeded',
      source: 'pipeline',
      severity: 'warning',
      category: 'budget',
      file: '<pipeline>',
      message: `Review budget of $${input.budgetRemainingUSD} USD exceeded — remaining chunks skipped`,
      protectedPath: false,
      createdAt: new Date().toISOString(),
    });
  }

  const hasCritical = allFindings.some(f => f.severity === 'critical');
  const hasWarning = allFindings.some(f => f.severity === 'warning');
  const status = hasCritical ? 'fail' : hasWarning ? 'warn' : 'pass';

  return {
    phase: 'review',
    status,
    findings: allFindings,
    costUSD: totalCostUSD > 0 ? totalCostUSD : undefined,
    usage: totalInputTokens > 0 ? { input: totalInputTokens, output: totalOutputTokens } : undefined,
    durationMs: Date.now() - start,
  };
}
