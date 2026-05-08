import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(__dirname, '../../../../../../data/deltas/20260508160000_phase5_2_audit_cost_rpcs.sql');
const DELTAS_DIR = resolve(__dirname, '../../../../../../data/deltas');

describe('Phase 5.2 RPC privilege model + hardening', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('REVOKE FROM PUBLIC, anon, authenticated', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM\s+PUBLIC,\s*anon,\s*authenticated/i);
  });

  it('GRANT EXECUTE TO service_role', () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO\s+service_role/i);
  });

  it('NO grant to authenticated', () => {
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO\s+authenticated\s*;/i);
  });

  it('both functions declare SECURITY DEFINER', () => {
    const matches = sql.match(/SECURITY DEFINER/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('both functions declare locked search_path', () => {
    const matches = sql.match(/SET\s+search_path\s*=\s*public,\s*audit,\s*auth,\s*pg_temp/gi) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('audit.events references are schema-qualified', () => {
    expect(sql).toMatch(/FROM\s+audit\.events/i);
    expect(sql).toMatch(/audit\.events\s*\(organization_id/i);
  });

  it('Phase 4 cost_usd migration exists in deltas (cost_usd dependency)', () => {
    const files = readdirSync(DELTAS_DIR);
    expect(files).toContain('20260508120000_phase4_runs_metadata.sql');
  });
});
