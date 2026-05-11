// tests/audit-supabase-imports.test.ts
//
// Unit tests for the AST-based audit of `@supabase/supabase-js` value imports
// in `src/**/*.ts`. The audit is a fail-closed CI gate that protects the
// v7.8.0 contract: supabase is an `optionalDependency`, so any static
// value-import outside the dashboard allowlist would break local-only users
// who installed with `npm install --omit=optional`.
//
// Covers the false negatives Codex flagged in PR #172 review:
//   - `import '@supabase/supabase-js';` (side-effect, no importClause)
//   - `import x from '@supabase/supabase-js';` (default value import — older
//     audit gated this on namedBindings being present)
//   - `export { x } from '@supabase/supabase-js';` (re-export)
//   - `import x = require('@supabase/supabase-js');` (TS import-equals)
//
// Also verifies erased forms (whole-type-only, all-named-type-only) are NOT
// flagged so we don't regress on the type-import escape valve.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditSourceForTest } from '../scripts/audit-supabase-imports.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Path NOT in the dashboard allowlist — these audits should fire.
const NON_ALLOWED = path.join(ROOT, 'src', 'core', 'fake-not-allowlisted.ts');
// Path inside the dashboard allowlist — these audits should pass even for
// value imports (the allowlist permits the lazy-load probe pattern).
const ALLOWED = path.join(ROOT, 'src', 'cli', 'dashboard', 'fake-allowlisted.ts');

describe('audit-supabase-imports: false-negative regressions', () => {
  it('A1: side-effect-only import → flagged', () => {
    const src = `import '@supabase/supabase-js';\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.reason, /side-effect import/);
  });

  it('A2: default value import → flagged', () => {
    const src = `import supabase from '@supabase/supabase-js';\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.reason, /static value-import/);
  });

  it('A3: default value import + named type-only → still flagged (default is the value)', () => {
    // `import supabase, { type SomeType } from '...'` — the default
    // binding is a value import, the named binding is type-only. Older
    // audit gated `hasValueNamedImport` on namedBindings being a value
    // import AND the clause not being type-only, which silently missed
    // this form because namedBindings was all type-only.
    const src = `import supabase, { type Client } from '@supabase/supabase-js';\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.reason, /static value-import/);
  });

  it('A4: namespace value import → flagged', () => {
    const src = `import * as supabase from '@supabase/supabase-js';\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 1);
  });

  it('A5: re-export → flagged', () => {
    const src = `export { createClient } from '@supabase/supabase-js';\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.reason, /re-export/);
  });

  it('A6: star re-export → flagged', () => {
    const src = `export * from '@supabase/supabase-js';\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.reason, /re-export/);
  });

  it('A7: TS import = require(...) → flagged', () => {
    const src = `import supabase = require('@supabase/supabase-js');\nsupabase.createClient('u','k');\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.reason, /import = require/);
  });
});

describe('audit-supabase-imports: erased forms (must NOT fire)', () => {
  it('whole-clause type-only: `import type { ... } from ...` → not flagged', () => {
    const src = `import type { SupabaseClient } from '@supabase/supabase-js';\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 0);
  });

  it('all-named-type-only: `import { type X, type Y } from ...` → not flagged', () => {
    const src = `import { type SupabaseClient, type AuthResponse } from '@supabase/supabase-js';\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 0);
  });

  it('type-only re-export: `export type { X } from ...` → not flagged', () => {
    const src = `export type { SupabaseClient } from '@supabase/supabase-js';\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 0);
  });

  it('all-named-type-only re-export: `export { type X } from ...` → not flagged', () => {
    const src = `export { type SupabaseClient } from '@supabase/supabase-js';\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 0);
  });
});

describe('audit-supabase-imports: dashboard allowlist', () => {
  it('value imports in src/cli/dashboard/** are allowed', () => {
    const src = `
      import { createClient } from '@supabase/supabase-js';
      import supabase from '@supabase/supabase-js';
      import '@supabase/supabase-js';
      export { createClient } from '@supabase/supabase-js';
    `;
    const violations = auditSourceForTest(ALLOWED, src);
    assert.equal(violations.length, 0, 'dashboard allowlist must permit value imports');
  });
});

describe('audit-supabase-imports: dynamic import + require', () => {
  it('dynamic import outside allowlist → flagged', () => {
    const src = `async function load() { return await import('@supabase/supabase-js'); }\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.reason, /dynamic import/);
  });
  it('require outside allowlist → flagged', () => {
    const src = `const supabase = require('@supabase/supabase-js');\n`;
    const violations = auditSourceForTest(NON_ALLOWED, src);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.reason, /require/);
  });
});
