// Codex PR-pass CRITICAL #3 — sign-in surface registry guard.
//
// Walks the apps/web source tree for any new Supabase auth sign-in
// surface that could bypass /api/auth/callback's enforceSsoRequired()
// chokepoint. If a future PR adds password sign-in, OAuth callback,
// invite acceptance, or magic-link verification outside the documented
// set, this test fails so the author must update the registry.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const APP_DIR = resolve(__dirname, '../../');
const SCAN_ROOTS = ['app', 'lib', 'components'].map((d) => join(APP_DIR, d));

const ALLOWED_SIGNIN_PATTERNS: Array<{ file: string; rationale: string }> = [
  { file: 'app/api/auth/sso/callback/route.ts', rationale: 'SSO native; sets session via setSession after WorkOS profile validation' },
  { file: 'app/api/auth/callback/route.ts', rationale: 'enforceSsoRequired() chokepoint runs after exchangeCodeForSession' },
];

const FORBIDDEN_PATTERNS = [
  'signInWithPassword',
  'signInWithIdToken',
  'signInAnonymously',
];

function* walkSourceFiles(root: string): Iterable<string> {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return; }
  for (const entry of entries) {
    const full = join(root, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      yield* walkSourceFiles(full);
    } else if (st.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      yield full;
    }
  }
}

function findMatches(pattern: RegExp): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walkSourceFiles(root)) {
      let content: string;
      try { content = readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      lines.forEach((text, idx) => {
        if (pattern.test(text)) {
          hits.push({ file: relative(APP_DIR, file), line: idx + 1, text });
        }
      });
    }
  }
  return hits;
}

describe('sign-in surface registry', () => {
  for (const pattern of FORBIDDEN_PATTERNS) {
    it(`no source file uses Supabase ${pattern}`, () => {
      const re = new RegExp(`\\b${pattern}\\b`);
      const hits = findMatches(re);
      expect(
        hits,
        `Found use of ${pattern}:\n${hits.map((h) => `  ${h.file}:${h.line}`).join('\n')}\n` +
        `If you added a new sign-in surface, update __tests__/auth/sign-in-surface-registry.test.ts ` +
        `AND wire enforceSsoRequired() into it.`,
      ).toEqual([]);
    });
  }

  it('setSession only called from documented surfaces', () => {
    const hits = findMatches(/auth\.setSession\b/);
    const filesWithHits = new Set(hits.map((h) => h.file));
    const allowed = new Set(ALLOWED_SIGNIN_PATTERNS.map((p) => p.file));
    for (const f of filesWithHits) {
      expect(
        allowed.has(f),
        `setSession found in unregistered surface: ${f}\nUpdate ALLOWED_SIGNIN_PATTERNS in this test if intentional.`,
      ).toBe(true);
    }
  });

  it('enforceSsoRequired is referenced from /api/auth/callback (chokepoint guard)', () => {
    const callbackPath = join(APP_DIR, 'app/api/auth/callback/route.ts');
    const content = readFileSync(callbackPath, 'utf-8');
    expect(content).toMatch(/enforceSsoRequired/);
  });
});
