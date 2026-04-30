import * as fs from 'node:fs';
import * as path from 'node:path';

const CACHE_DIR = '.guardrail-cache';
const LOG_FILE = 'costs.jsonl';

export interface CostLogEntry {
  timestamp: string;
  files: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  durationMs: number;
}

export function appendCostLog(cwd: string, entry: CostLogEntry): void {
  // Cost log is observability, not a contract. A failed write (read-only FS,
  // full disk, permission error) must NEVER block the caller — every callsite
  // calls this *after* its primary output is emitted, and a throw here would
  // cause unhandled-rejection crashes after work has already succeeded.
  // Bugbot HIGH on PR #51 surfaced this for pr-desc/council; consolidating
  // the swallow here so the same defense applies to scan/run automatically.
  try {
    const dir = path.join(cwd, CACHE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, LOG_FILE), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Intentionally empty — observability failures should not surface to users.
  }
}

export function readCostLog(cwd: string): CostLogEntry[] {
  const p = path.join(cwd, CACHE_DIR, LOG_FILE);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) as CostLogEntry; } catch { return null; } })
    .filter((e): e is CostLogEntry => e !== null);
}
