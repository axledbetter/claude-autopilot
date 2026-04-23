import * as crypto from 'node:crypto';
import * as path from 'node:path';
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
    // Store relative key so fix_finding's finding.file lookup matches
    const relKey = path.relative(workspace, f);
    fileChecksums[relKey] = checksumFile(f);
  }
  // Normalize finding.file to relative paths so downstream lookups against
  // fileChecksums (keyed by relative paths) work regardless of whether the
  // review engine echoed absolute or relative paths.
  const normalizedFindings = result.findings.map(f => {
    if (!f.file) return f;
    const rel = path.isAbsolute(f.file) ? path.relative(workspace, f.file) : f.file;
    return rel === f.file ? f : { ...f, file: rel };
  });
  saveRun(workspace, run_id, normalizedFindings, fileChecksums);

  const critCount = result.findings.filter(f => f.severity === 'critical').length;
  const warnCount = result.findings.filter(f => f.severity === 'warning').length;
  const human_summary = result.findings.length === 0
    ? 'No findings.'
    : `${result.findings.length} finding${result.findings.length !== 1 ? 's' : ''}: ${critCount} critical, ${warnCount} warning.`;

  return { schema_version: 1, run_id, findings: normalizedFindings, human_summary };
}
