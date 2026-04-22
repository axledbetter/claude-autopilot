import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from '../findings/types.ts';

const CACHE_DIR = '.guardrail-cache';
const CACHE_FILE = 'findings.json';

function cacheFilePath(cwd: string): string {
  return path.join(cwd, CACHE_DIR, CACHE_FILE);
}

function findingKey(f: Finding): string {
  return `${f.id}::${f.file}::${f.line ?? ''}`;
}

export function loadCachedFindings(cwd: string): Finding[] {
  const p = cacheFilePath(cwd);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Finding[];
  } catch {
    return [];
  }
}

export function saveCachedFindings(cwd: string, findings: Finding[]): void {
  const dir = path.join(cwd, CACHE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  // atomic write
  const tmp = cacheFilePath(cwd) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(findings, null, 2), 'utf8');
  fs.renameSync(tmp, cacheFilePath(cwd));
}

/**
 * Returns only findings not present in the cached baseline.
 * Two findings are considered the same when id + file + line all match.
 */
export function filterNewFindings(current: Finding[], cached: Finding[]): Finding[] {
  if (cached.length === 0) return current;
  const seen = new Set(cached.map(findingKey));
  return current.filter(f => !seen.has(findingKey(f)));
}
