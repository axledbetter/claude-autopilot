import type { AutopilotConfig } from '../config/types.ts';
import type { StaticRule } from '../phases/static-rules.ts';
import type { ReviewEngine } from '../../adapters/review-engine/types.ts';
import type { Finding } from '../findings/types.ts';
import type { StaticRulesPhaseResult } from '../phases/static-rules.ts';
import type { TestsPhaseResult } from '../phases/tests.ts';
import type { ReviewPhaseResult } from './review-phase.ts';
import { runStaticRulesPhase } from '../phases/static-rules.ts';
import { runTestsPhase } from '../phases/tests.ts';
import { runReviewPhase } from './review-phase.ts';

export type PhaseResult = StaticRulesPhaseResult | TestsPhaseResult | ReviewPhaseResult;

export interface RunInput {
  touchedFiles: string[];
  config: AutopilotConfig;
  reviewEngine?: ReviewEngine;
  staticRules?: StaticRule[];
  cwd?: string;
}

export interface RunResult {
  status: 'pass' | 'warn' | 'fail';
  phases: PhaseResult[];
  allFindings: Finding[];
  totalCostUSD?: number;
  durationMs: number;
}

export async function runAutopilot(input: RunInput): Promise<RunResult> {
  const start = Date.now();
  const phases: PhaseResult[] = [];
  let totalCostUSD: number | undefined;

  // Static-rules phase — fail fast on critical
  if (input.staticRules && input.staticRules.length > 0) {
    const result = await runStaticRulesPhase({
      touchedFiles: input.touchedFiles,
      rules: input.staticRules,
    });
    phases.push(result);
    if (result.status === 'fail') return finalize(phases, start, totalCostUSD);
  }

  // Tests phase — fail fast on test failure
  const testsResult = await runTestsPhase({
    touchedFiles: input.touchedFiles,
    testCommand: input.config.testCommand,
    cwd: input.cwd,
  });
  phases.push(testsResult);
  if (testsResult.status === 'fail') return finalize(phases, start, totalCostUSD);

  // Review phase (optional — only when engine is provided)
  if (input.reviewEngine) {
    const budgetUSD = (input.config.cost as { budgetUSD?: number } | undefined)?.budgetUSD;
    const reviewResult = await runReviewPhase({
      touchedFiles: input.touchedFiles,
      engine: input.reviewEngine,
      config: input.config,
      cwd: input.cwd,
      budgetRemainingUSD: budgetUSD,
    });
    phases.push(reviewResult);
    if (reviewResult.costUSD !== undefined) {
      totalCostUSD = (totalCostUSD ?? 0) + reviewResult.costUSD;
    }
  }

  return finalize(phases, start, totalCostUSD);
}

function finalize(phases: PhaseResult[], start: number, totalCostUSD: number | undefined): RunResult {
  const allFindings: Finding[] = phases.flatMap(p => p.findings);
  // Trust each phase's own status — it accounts for autofixes and dedup
  const anyFail = phases.some(p => p.status === 'fail');
  const anyWarn = phases.some(p => p.status === 'warn');
  const status: RunResult['status'] = anyFail ? 'fail' : anyWarn ? 'warn' : 'pass';
  return { status, phases, allFindings, totalCostUSD, durationMs: Date.now() - start };
}
