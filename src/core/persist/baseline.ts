import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from '../findings/types.ts';

const BASELINE_FILE = '.guardrail-baseline.json';

export interface BaselineEntry {
  id: string;
  file: string;
  line?: number;
  severity: string;
  message: string;
  pinnedAt: string;
  note?: string;
}

export interface Baseline {
  version: 1;
  createdAt: string;
  updatedAt: string;
  note?: string;
  entries: BaselineEntry[];
}

/** Stable key for matching a finding against a baseline entry. */
function baselineKey(f: { id: string; file: string; line?: number }): string {
  return `${f.id}::${f.file}::${f.line ?? ''}`;
}

export function baselineFilePath(cwd: string, overridePath?: string): string {
  return overridePath
    ? path.isAbsolute(overridePath) ? overridePath : path.join(cwd, overridePath)
    : path.join(cwd, BASELINE_FILE);
}

export function loadBaseline(cwd: string, overridePath?: string): Baseline | null {
  const p = baselineFilePath(cwd, overridePath);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Baseline;
  } catch {
    return null;
  }
}

export function saveBaseline(cwd: string, findings: Finding[], options: { note?: string; overridePath?: string } = {}): Baseline {
  const existing = loadBaseline(cwd, options.overridePath);
  const now = new Date().toISOString();
  const baseline: Baseline = {
    version: 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    note: options.note ?? existing?.note,
    entries: findings.map(f => ({
      id: f.id,
      file: f.file,
      line: f.line,
      severity: f.severity,
      message: f.message,
      pinnedAt: now,
    })),
  };
  const p = baselineFilePath(cwd, options.overridePath);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(baseline, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return baseline;
}

export function clearBaseline(cwd: string, overridePath?: string): void {
  const p = baselineFilePath(cwd, overridePath);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export interface BaselineFilterResult {
  newFindings: Finding[];
  baselinedFindings: Finding[];
  baselinedCount: number;
}

/** Returns findings NOT present in the baseline (new findings only). */
export function filterBaselined(findings: Finding[], baseline: Baseline): BaselineFilterResult {
  const pinned = new Set(baseline.entries.map(baselineKey));
  const newFindings: Finding[] = [];
  const baselinedFindings: Finding[] = [];
  for (const f of findings) {
    if (pinned.has(baselineKey(f))) {
      baselinedFindings.push(f);
    } else {
      newFindings.push(f);
    }
  }
  return { newFindings, baselinedFindings, baselinedCount: baselinedFindings.length };
}

export interface BaselineDiff {
  added: Finding[];       // in current but not in baseline
  resolved: BaselineEntry[]; // in baseline but not in current
  unchanged: Finding[];   // in both
}

/** Diff current findings against a baseline snapshot. */
export function diffAgainstBaseline(current: Finding[], baseline: Baseline): BaselineDiff {
  const currentKeys = new Set(current.map(baselineKey));
  const baselineKeys = new Set(baseline.entries.map(baselineKey));

  return {
    added:     current.filter(f => !baselineKeys.has(baselineKey(f))),
    resolved:  baseline.entries.filter(e => !currentKeys.has(baselineKey(e))),
    unchanged: current.filter(f => baselineKeys.has(baselineKey(f))),
  };
}
