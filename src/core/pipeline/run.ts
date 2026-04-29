import type { GuardrailConfig } from '../config/types.ts';
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
  config: GuardrailConfig;
  reviewEngine?: ReviewEngine;
  staticRules?: StaticRule[];
  cwd?: string;
  gitSummary?: string;
  base?: string;
  skipReview?: boolean;
}

export interface RunResult {
  status: 'pass' | 'warn' | 'fail';
  phases: PhaseResult[];
  allFindings: Finding[];
  totalCostUSD?: number;
  durationMs: number;
}

export async function runGuardrail(input: RunInput): Promise<RunResult> {
  const start = Date.now();
  const phases: PhaseResult[] = [];
  let totalCostUSD: number | undefined;

  const pipelineCfg = input.config.pipeline ?? {};
  // Default true: when the user wires up a review engine they expect it to actually run.
  // Skipping LLM review on static-fail is exactly the "silent skip" behavior the v4.0
  // reviewer flagged — the bugs the LLM is best at often ride alongside one a static
  // rule already caught.
  const runReviewOnStaticFail = pipelineCfg.runReviewOnStaticFail !== false;
  // Default true (5.0.5+): when an auto-detected test command fails or is missing
  // (e.g. `npm test` on a Python repo with no test script), skipping review made
  // first-runs return zero useful output. Review on failing code is exactly when
  // it's most useful. Users who explicitly set `runReviewOnTestFail: false` keep
  // the strict behavior.
  const runReviewOnTestFail = pipelineCfg.runReviewOnTestFail !== false;

  // Static-rules phase — tests always run afterward, regardless of status. The
  // runReviewOnStaticFail flag only gates the LLM review phase (matching its name);
  // skipping tests on a static-fail would be surprising and asymmetric with
  // runReviewOnTestFail which only gates the review phase too.
  let staticFailed = false;
  if (input.staticRules && input.staticRules.length > 0) {
    const result = await runStaticRulesPhase({
      touchedFiles: input.touchedFiles,
      rules: input.staticRules,
      config: input.config,
      engine: input.reviewEngine,
    });
    phases.push(result);
    staticFailed = result.status === 'fail';
  }

  // skipReview short-circuit: skip tests and review phases entirely
  if (input.skipReview) {
    const allFindings = phases.flatMap(p => p.findings ?? []);
    const hasCritical = allFindings.some(f => f.severity === 'critical');
    return {
      status: hasCritical ? 'fail' : 'pass',
      phases,
      allFindings,
      totalCostUSD: undefined,
      durationMs: Date.now() - start,
    };
  }

  // Tests phase — always runs (unless skipReview above). The runReviewOnTestFail
  // flag only gates the subsequent review phase.
  const testsResult = await runTestsPhase({
    touchedFiles: input.touchedFiles,
    testCommand: input.config.testCommand,
    cwd: input.cwd,
  });
  phases.push(testsResult);
  const testsFailed = testsResult.status === 'fail';

  // Review phase (optional — only when engine is provided, not gated off by flags)
  const skipReviewDueToStatic = staticFailed && !runReviewOnStaticFail;
  const skipReviewDueToTests = testsFailed && !runReviewOnTestFail;
  if (input.reviewEngine && !skipReviewDueToStatic && !skipReviewDueToTests) {
    const costCfg = input.config.cost as { maxPerRun?: number; budgetUSD?: number } | undefined;
    const budgetUSD = costCfg?.maxPerRun ?? costCfg?.budgetUSD;
    const reviewResult = await runReviewPhase({
      touchedFiles: input.touchedFiles,
      engine: input.reviewEngine,
      config: input.config,
      cwd: input.cwd,
      gitSummary: input.gitSummary,
      budgetRemainingUSD: budgetUSD,
      base: input.base,
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
