import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Finding } from '../findings/types.ts';

const RUNS_DIR = '.guardrail-cache/runs';

export interface RunRecord {
  run_id: string;
  createdAt: string;
  findings: Finding[];
  fileChecksums: Record<string, string>;
}

function runsDir(cwd: string): string {
  return path.join(cwd, RUNS_DIR);
}

// Reject any run_id that isn't a safe filename component — path separators,
// relative segments, hidden files, or empty strings.
// run_ids are generated server-side as UUIDs (crypto.randomUUID) so strict
// validation here is safe. MCP clients that fabricate run_ids get a clear
// rejection instead of silently reading outside RUNS_DIR.
const VALID_RUN_ID = /^[A-Za-z0-9_-]+$/;

function assertValidRunId(runId: string): void {
  if (!runId || typeof runId !== 'string' || !VALID_RUN_ID.test(runId)) {
    throw Object.assign(
      new Error(`invalid run_id: "${runId}" (expected alphanumeric + dash/underscore)`),
      { code: 'invalid_run_id' },
    );
  }
}

function runFilePath(cwd: string, runId: string): string {
  assertValidRunId(runId);
  return path.join(runsDir(cwd), `${runId}.json`);
}

export function saveRun(
  cwd: string,
  runId: string,
  findings: Finding[],
  fileChecksums: Record<string, string>,
): void {
  const dir = runsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const record: RunRecord = { run_id: runId, createdAt: new Date().toISOString(), findings, fileChecksums };
  const tmp = runFilePath(cwd, runId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, runFilePath(cwd, runId));
}

export function loadRun(cwd: string, runId: string): RunRecord | null {
  const p = runFilePath(cwd, runId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}

export function checksumFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

export function pruneOldRuns(cwd: string, maxAgeMs: number): void {
  const dir = runsDir(cwd);
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    } catch { /* ignore */ }
  }
}
