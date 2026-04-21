// src/core/findings/dedup.ts

import type { Finding } from './types.ts';

function dedupKey(f: Finding): string {
  return `${f.file}|${f.line ?? ''}|${f.severity}|${f.message.slice(0, 40)}`;
}

export function dedupFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = dedupKey(f);
    if (!seen.has(key)) seen.set(key, f);
  }
  return Array.from(seen.values());
}
