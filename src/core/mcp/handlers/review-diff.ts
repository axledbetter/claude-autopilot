import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { resolveWorkspace } from '../workspace.ts';
import { saveRun, checksumFile, pruneOldRuns } from '../run-store.ts';
import { runGuardrail } from '../../pipeline/run.ts';
import { resolveGitTouchedFiles } from '../../git/touched-files.ts';
import { loadRulesFromConfig } from '../../static-rules/registry.ts';
import { detectGitContext } from '../../detect/git-context.ts';
import type { ReviewEngine } from '../../../adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../config/types.ts';
import type { Finding } from '../../findings/types.ts';

export interface ReviewDiffResult {
  schema_version: 1;
  run_id: string;
  findings: Finding[];
  human_summary: string;
  usage?: { costUSD?: number };
}

export async function handleReviewDiff(
  input: { base?: string; cwd?: string; static_only?: boolean },
  config: GuardrailConfig,
  engine: ReviewEngine,
): Promise<ReviewDiffResult> {
  const workspace = resolveWorkspace(input.cwd);
  pruneOldRuns(workspace, 24 * 60 * 60 * 1000);

  const touchedFiles = resolveGitTouchedFiles({ cwd: workspace, base: input.base });
  const staticRules = config.staticRules ? await loadRulesFromConfig(config.staticRules) : [];
  const gitCtx = detectGitContext(workspace);

  const result = await runGuardrail({
    touchedFiles,
    config,
    reviewEngine: engine,
    staticRules,
    cwd: workspace,
    gitSummary: gitCtx.summary ?? undefined,
    base: input.base,
    skipReview: input.static_only ?? false,
  });

  const run_id = crypto.randomUUID();
  const fileChecksums: Record<string, string> = {};
  for (const f of touchedFiles) {
    const abs = path.isAbsolute(f) ? f : path.resolve(workspace, f);
    fileChecksums[f] = checksumFile(abs);
  }
  saveRun(workspace, run_id, result.allFindings, fileChecksums);

  const critCount = result.allFindings.filter(f => f.severity === 'critical').length;
  const warnCount = result.allFindings.filter(f => f.severity === 'warning').length;
  const human_summary = result.allFindings.length === 0
    ? 'No findings — looks clean.'
    : `${result.allFindings.length} finding${result.allFindings.length !== 1 ? 's' : ''}: ${critCount} critical, ${warnCount} warning.`;

  return {
    schema_version: 1,
    run_id,
    findings: result.allFindings,
    human_summary,
    usage: result.totalCostUSD !== undefined ? { costUSD: result.totalCostUSD } : undefined,
  };
}
