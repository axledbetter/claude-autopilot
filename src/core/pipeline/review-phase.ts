import type { ReviewEngine } from '../../adapters/review-engine/types.ts';
import type { Finding } from '../findings/types.ts';
import type { GuardrailConfig } from '../config/types.ts';
import { buildReviewChunks, type ReviewChunk } from '../chunking/index.ts';

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
  config: GuardrailConfig;
  cwd?: string;
  gitSummary?: string;
  budgetRemainingUSD?: number;
  base?: string;
}

interface ChunkResult {
  findings: Finding[];
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

async function reviewChunk(chunk: ReviewChunk, input: ReviewPhaseInput): Promise<ChunkResult> {
  const output = await input.engine.review({
    content: chunk.content,
    kind: chunk.kind,
    context: { stack: input.config.stack, cwd: input.cwd, gitSummary: input.gitSummary },
  });
  return {
    findings: output.findings,
    inputTokens: output.usage?.input ?? 0,
    outputTokens: output.usage?.output ?? 0,
    costUSD: output.usage?.costUSD ?? 0,
  };
}

/** Run up to `limit` promises concurrently, preserving result order. */
async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
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
    base: input.base,
  });

  const parallelism = input.config.chunking?.parallelism ?? 3;
  const budgetUSD = input.budgetRemainingUSD;

  // For budget tracking we still need to enforce it — run serially if budget set,
  // parallel otherwise (budget check between serial chunks is the safe path).
  let chunkResults: ChunkResult[];
  if (budgetUSD !== undefined) {
    chunkResults = [];
    let spent = 0;
    let budgetExceeded = false;
    for (const chunk of chunks) {
      if (spent >= budgetUSD) { budgetExceeded = true; break; }
      const r = await reviewChunk(chunk, input);
      spent += r.costUSD;
      chunkResults.push(r);
    }
    if (budgetExceeded) {
      chunkResults.push({
        findings: [{
          id: 'budget-exceeded',
          source: 'pipeline',
          severity: 'warning',
          category: 'budget',
          file: '<pipeline>',
          message: `Review budget of $${budgetUSD} USD exceeded — remaining chunks skipped`,
          protectedPath: false,
          createdAt: new Date().toISOString(),
        }],
        inputTokens: 0, outputTokens: 0, costUSD: 0,
      });
    }
  } else {
    chunkResults = await pMap(chunks, chunk => reviewChunk(chunk, input), parallelism);
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUSD = 0;
  const allFindings: Finding[] = [];

  for (const r of chunkResults) {
    allFindings.push(...r.findings);
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCostUSD += r.costUSD;
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
