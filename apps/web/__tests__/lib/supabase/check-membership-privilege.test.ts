// apps/web/__tests__/lib/supabase/check-membership-privilege.test.ts
//
// v7.0 Phase 6 — spec test #10. Grep the migration to enforce:
//   1. SECURITY INVOKER (NOT SECURITY DEFINER per codex pass-2 WARNING #5,
//      pass-3 WARNING #2 — service_role already bypasses RLS, DEFINER
//      would only widen blast radius if grants are accidentally
//      extended to authenticated later).
//   2. REVOKE ALL ON FUNCTION ... FROM PUBLIC (and anon, authenticated).
//   3. GRANT EXECUTE ... TO service_role.
//
// Static check on the SQL file — no DB hit. Belt-and-suspenders for
// reviewers who skim deltas without running them.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  '../../../../../data/deltas/20260509200000_phase6_check_membership_rpc.sql',
);

describe('check_membership_status migration privilege contract', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  it('test #10: uses SECURITY INVOKER (NOT DEFINER)', () => {
    expect(sql).toMatch(/SECURITY\s+INVOKER/i);
    expect(sql).not.toMatch(/SECURITY\s+DEFINER/i);
  });

  it('test #10: REVOKEs from PUBLIC, anon, authenticated', () => {
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+[^;]*FROM\s+PUBLIC/i);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+[^;]*FROM\s+anon/i);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+[^;]*FROM\s+authenticated/i);
  });

  it('test #10: GRANTs EXECUTE to service_role only', () => {
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+[^;]*TO\s+service_role/i);
    // Sanity: the migration does not GRANT to authenticated (only service_role).
    expect(sql).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+[^;]*TO\s+authenticated/i);
  });

  it('test #10: function name and signature match the RPC the helper calls', () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.check_membership_status\(/i);
    expect(sql).toMatch(/p_org_id\s+uuid/i);
    expect(sql).toMatch(/p_user_id\s+uuid/i);
  });

  it('test #10: synthesizes a no_row response when there is no membership', () => {
    // Codex pass-1 NOTE #2: RPC always returns one row.
    expect(sql).toMatch(/'no_row'/);
  });

  it('test #10: function search_path is locked down', () => {
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public,\s*pg_temp/i);
  });
});
