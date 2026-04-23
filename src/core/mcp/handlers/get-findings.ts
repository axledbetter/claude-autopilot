import { resolveWorkspace } from '../workspace.ts';
import { loadRun } from '../run-store.ts';
import type { Finding, Severity } from '../../findings/types.ts';

export interface GetFindingsResult {
  schema_version: 1;
  run_id: string;
  findings: Finding[];
  cachedAt: string;
}

// Severity order: index 0 = highest priority
const SEVERITY_ORDER = ['critical', 'warning', 'note'] as const;

export async function handleGetFindings(input: {
  run_id: string;
  severity?: Severity;
  cwd?: string;
}): Promise<GetFindingsResult> {
  const workspace = resolveWorkspace(input.cwd);
  const record = loadRun(workspace, input.run_id);
  if (!record) {
    throw Object.assign(
      new Error(`run_not_found: no run with id "${input.run_id}"`),
      { code: 'run_not_found' }
    );
  }

  let findings = record.findings;
  if (input.severity) {
    const minIdx = SEVERITY_ORDER.indexOf(input.severity);
    findings = findings.filter(f => SEVERITY_ORDER.indexOf(f.severity) <= minIdx);
  }

  return { schema_version: 1, run_id: input.run_id, findings, cachedAt: record.createdAt };
}
