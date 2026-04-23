import * as crypto from 'node:crypto';
import { resolveWorkspace, assertInWorkspace } from '../workspace.ts';
import { saveRun, checksumFile, pruneOldRuns } from '../run-store.ts';
import { runReviewPhase } from '../../pipeline/review-phase.ts';
import { detectStack } from '../../detect/stack.ts';
import type { ReviewEngine } from '../../../adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../config/types.ts';
import type { Finding } from '../../findings/types.ts';

export interface ScanFilesResult {
  schema_version: 1;
  run_id: string;
  findings: Finding[];
  human_summary: string;
}

export async function handleScanFiles(
  input: { files: string[]; cwd?: string; ask?: string },
  config: GuardrailConfig,
  engine: ReviewEngine,
): Promise<ScanFilesResult> {
  const workspace = resolveWorkspace(input.cwd);
  pruneOldRuns(workspace, 24 * 60 * 60 * 1000);

  // Validate all paths before any I/O
  const resolvedFiles = input.files.map(f => assertInWorkspace(workspace, f));

  const stack = detectStack(workspace) ?? config.stack;
  const effectiveConfig: GuardrailConfig = input.ask
    ? { ...config, stack: `${stack ?? 'unknown'}\n\nFocus: ${input.ask}` }
    : config;

  const result = await runReviewPhase({
    touchedFiles: resolvedFiles,
    config: effectiveConfig,
    engine,
    cwd: workspace,
  });

  const run_id = crypto.randomUUID();
  const fileChecksums: Record<string, string> = {};
  for (const f of resolvedFiles) {
    fileChecksums[f] = checksumFile(f);
  }
  saveRun(workspace, run_id, result.findings, fileChecksums);

  const critCount = result.findings.filter(f => f.severity === 'critical').length;
  const warnCount = result.findings.filter(f => f.severity === 'warning').length;
  const human_summary = result.findings.length === 0
    ? 'No findings.'
    : `${result.findings.length} finding${result.findings.length !== 1 ? 's' : ''}: ${critCount} critical, ${warnCount} warning.`;

  return { schema_version: 1, run_id, findings: result.findings, human_summary };
}
