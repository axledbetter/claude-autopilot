// src/core/mcp/handlers/fix-finding.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveWorkspace, assertInWorkspace } from '../workspace.ts';
import { loadRun, checksumFile } from '../run-store.ts';
import { withWriteLock } from '../concurrency.ts';
import { generateFix, buildUnifiedDiff } from '../../fix/generator.ts';
import type { ReviewEngine } from '../../../adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../config/types.ts';

export interface FixFindingResult {
  schema_version: 1;
  status: 'fixed' | 'reverted' | 'human_required' | 'skipped';
  reason?: string;
  patch?: string;
  commitSha?: string;
  appliedFiles: string[];
}

export async function handleFixFinding(
  input: { run_id: string; finding_id: string; cwd?: string; dry_run?: boolean },
  config: GuardrailConfig,
  engine: ReviewEngine,
): Promise<FixFindingResult> {
  const workspace = resolveWorkspace(input.cwd);

  const record = loadRun(workspace, input.run_id);
  if (!record) {
    throw Object.assign(
      new Error(`run_not_found: no run with id "${input.run_id}"`),
      { code: 'run_not_found' },
    );
  }

  const finding = record.findings.find(f => f.id === input.finding_id);
  if (!finding) {
    throw Object.assign(
      new Error(`finding_not_found: no finding with id "${input.finding_id}"`),
      { code: 'finding_not_found' },
    );
  }

  // Protected path check
  if (finding.protectedPath) {
    return { schema_version: 1, status: 'human_required', reason: 'protected_path', appliedFiles: [] };
  }

  // Validate finding.file against workspace boundary (run records could be tampered)
  const absFile = assertInWorkspace(workspace, finding.file);

  // For dry-run we still do a best-effort checksum check and generate outside
  // the lock (read-only path). Real apply revalidates inside the lock.
  const savedChecksum = record.fileChecksums[finding.file] ?? '';

  // Dry-run path: generate fix, return patch, no mutations
  if (input.dry_run) {
    const currentChecksum = checksumFile(absFile);
    if (savedChecksum && currentChecksum !== savedChecksum) {
      return { schema_version: 1, status: 'human_required', reason: 'file_changed', appliedFiles: [] };
    }
    const genResult = await generateFix(finding, engine, workspace);
    if (genResult.status !== 'ok') {
      return { schema_version: 1, status: 'human_required', reason: genResult.reason, appliedFiles: [] };
    }
    const patch = buildUnifiedDiff(
      genResult.originalLines!,
      genResult.replacementLines!,
      finding.file,
      genResult.startLine!,
      { color: false }, // MCP clients parse patch text — no ANSI
    );
    return { schema_version: 1, status: 'skipped', reason: 'dry_run', patch, appliedFiles: [] };
  }

  // Apply path: checksum validation + fix generation run INSIDE the lock to
  // prevent TOCTOU between two concurrent fix_finding calls on the same file.
  return withWriteLock(workspace, async () => {
    const currentChecksum = checksumFile(absFile);
    if (savedChecksum && currentChecksum !== savedChecksum) {
      return { schema_version: 1 as const, status: 'human_required' as const, reason: 'file_changed', appliedFiles: [] };
    }

    const genResult = await generateFix(finding, engine, workspace);
    if (genResult.status !== 'ok') {
      return { schema_version: 1 as const, status: 'human_required' as const, reason: genResult.reason, appliedFiles: [] };
    }

    const patch = buildUnifiedDiff(
      genResult.originalLines!,
      genResult.replacementLines!,
      finding.file,
      genResult.startLine!,
      { color: false },
    );

    const originalContent = fs.readFileSync(absFile, 'utf8');
    const allLines = originalContent.split('\n');
    const newLines = [
      ...allLines.slice(0, genResult.startLine! - 1),
      ...genResult.replacementLines!,
      ...allLines.slice(genResult.endLine!),
    ];

    const tmpFile = absFile + '.guardrail.tmp';
    fs.writeFileSync(tmpFile, newLines.join('\n'), 'utf8');
    fs.renameSync(tmpFile, absFile);

    // Test verification
    if (config.testCommand) {
      const { spawnSync } = await import('node:child_process');
      const testResult = spawnSync('/bin/sh', ['-c', config.testCommand], {
        cwd: workspace,
        shell: false,
        timeout: 120_000,
        encoding: 'utf8',
      });
      if (testResult.status !== 0) {
        fs.writeFileSync(absFile, originalContent, 'utf8');
        return { schema_version: 1 as const, status: 'reverted' as const, patch, appliedFiles: [] };
      }
    }

    return { schema_version: 1 as const, status: 'fixed' as const, patch, appliedFiles: [finding.file] };
  });
}
