import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from '../findings/types.ts';

const TRIAGE_FILE = '.guardrail-triage.json';

export type TriageState = 'accepted-risk' | 'false-positive';

export interface TriageEntry {
  id: string;
  file: string;
  line?: number;
  state: TriageState;
  reason?: string;
  triagedAt: string;
  expiresAt?: string;
}

export interface TriageStore {
  version: 1;
  entries: TriageEntry[];
}

function triageFilePath(cwd: string): string {
  return path.join(cwd, TRIAGE_FILE);
}

function entryKey(e: { id: string; file: string; line?: number }): string {
  return `${e.id}::${e.file}::${e.line ?? ''}`;
}

export function loadTriage(cwd: string): TriageStore {
  const p = triageFilePath(cwd);
  if (!fs.existsSync(p)) return { version: 1, entries: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as TriageStore;
  } catch {
    return { version: 1, entries: [] };
  }
}

export function saveTriage(cwd: string, store: TriageStore): void {
  const p = triageFilePath(cwd);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

export function addTriageEntry(
  cwd: string,
  finding: Finding,
  state: TriageState,
  options: { reason?: string; expiresInDays?: number } = {},
): void {
  const store = loadTriage(cwd);
  const key = entryKey(finding);
  store.entries = store.entries.filter(e => entryKey(e) !== key);
  const entry: TriageEntry = {
    id: finding.id,
    file: finding.file,
    line: finding.line,
    state,
    reason: options.reason,
    triagedAt: new Date().toISOString(),
  };
  if (options.expiresInDays !== undefined) {
    const exp = new Date();
    exp.setDate(exp.getDate() + options.expiresInDays);
    entry.expiresAt = exp.toISOString();
  }
  store.entries.push(entry);
  saveTriage(cwd, store);
}

export function removeTriageEntry(cwd: string, ids: string[]): number {
  const store = loadTriage(cwd);
  const before = store.entries.length;
  store.entries = store.entries.filter(e => !ids.some(id => e.id === id || e.id.startsWith(id)));
  saveTriage(cwd, store);
  return before - store.entries.length;
}

export function clearExpiredEntries(cwd: string): number {
  const store = loadTriage(cwd);
  const now = new Date().toISOString();
  const before = store.entries.length;
  store.entries = store.entries.filter(e => !e.expiresAt || e.expiresAt > now);
  saveTriage(cwd, store);
  return before - store.entries.length;
}

export interface TriageFilterResult {
  active: Finding[];
  triaged: Finding[];
  triageCount: number;
}

export function filterTriaged(findings: Finding[], store: TriageStore): TriageFilterResult {
  const now = new Date().toISOString();
  const activeKeys = new Set(
    store.entries
      .filter(e => !e.expiresAt || e.expiresAt > now)
      .map(entryKey),
  );
  const active: Finding[] = [];
  const triaged: Finding[] = [];
  for (const f of findings) {
    if (activeKeys.has(entryKey(f))) triaged.push(f);
    else active.push(f);
  }
  return { active, triaged, triageCount: triaged.length };
}
