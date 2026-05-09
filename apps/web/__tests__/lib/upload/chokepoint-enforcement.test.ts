// v7.1 — defense-in-depth grep test for the JWT chokepoint.
//
// Codex PR-pass WARNING #2: the `.eslintrc.json` no-restricted-imports
// rule was added per the spec, but Next.js 16 + the apps/web package
// have no `lint` script and no eslint dependency wired into CI. The
// rule therefore never fires in practice. This test does the
// structural equivalent in vitest:
//
//   For every route file under app/api/runs/**, fail if it imports
//   `verifyUploadToken` or `_verifyUploadTokenInternal` directly from
//   `@/lib/upload/jwt`. Routes MUST go through
//   `verifyTokenAndAssertRunMembership()` from `@/lib/upload/auth`.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROUTES_ROOT = join(__dirname, '..', '..', '..', 'app', 'api', 'runs');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === 'route.ts' || entry === 'route.tsx') out.push(full);
  }
  return out;
}

describe('v7.1 chokepoint — app/api/runs/** must NOT bypass the orchestrator', () => {
  const routeFiles = walk(ROUTES_ROOT);

  it('discovers at least events + finalize routes (sanity)', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of routeFiles) {
    it(`${file.replace(ROUTES_ROOT, 'app/api/runs')} does not import bare verifier`, () => {
      const src = readFileSync(file, 'utf8');
      // Direct imports of the bare verifier are forbidden. Type-only
      // imports (`import type { UploadTokenClaims }`) and TokenError
      // are still fine.
      const forbiddenPatterns = [
        /import\s*{[^}]*\bverifyUploadToken\b[^}]*}\s*from\s*['"]@\/lib\/upload\/jwt['"]/,
        /import\s*{[^}]*\b_verifyUploadTokenInternal\b[^}]*}\s*from\s*['"]@\/lib\/upload\/jwt['"]/,
      ];
      for (const re of forbiddenPatterns) {
        expect(src, `${file} bypasses the v7.1 orchestrator`).not.toMatch(re);
      }
    });
  }
});
