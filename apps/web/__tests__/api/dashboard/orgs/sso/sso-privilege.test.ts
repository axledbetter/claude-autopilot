import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(__dirname, '../../../../../../../data/deltas/20260508180000_phase5_4_workos_setup.sql');

describe('Phase 5.4 SSO migration privilege model + hardening', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('REVOKE FROM PUBLIC, anon, authenticated', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM\s+PUBLIC,\s*anon,\s*authenticated/i);
  });

  it('GRANT EXECUTE TO service_role', () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO\s+service_role/i);
  });

  it('NO grant to authenticated/anon', () => {
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO\s+authenticated\s*;/i);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO\s+anon\s*;/i);
  });

  it('all 3 RPCs declare SECURITY DEFINER', () => {
    const matches = sql.match(/SECURITY DEFINER/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('all RPCs declare locked search_path', () => {
    const matches = sql.match(/SET\s+search_path\s*=\s*public,\s*audit,\s*auth,\s*pg_temp/gi) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('schema-qualified references — public.memberships, public.organization_settings, audit.append', () => {
    expect(sql).toMatch(/FROM\s+public\.memberships/);
    expect(sql).toMatch(/FROM\s+public\.organization_settings/);
    expect(sql).toMatch(/audit\.append/);
  });

  it('processed_workos_events ledger has claim/lease/complete columns', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.processed_workos_events/);
    expect(sql).toMatch(/locked_until/);
    expect(sql).toMatch(/attempt_count/);
    expect(sql).toMatch(/processing_started_at/);
    expect(sql).toMatch(/CHECK\s*\(status\s+IN\s*\('processing',\s*'processed',\s*'failed'\)\)/);
  });

  it('workos_organization_id and workos_connection_id have unique partial indexes', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^\n]*organization_settings_workos_organization_id_idx/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^\n]*organization_settings_workos_connection_id_idx/);
  });

  it('record_sso_setup_initiated raises workos_org_already_bound on active reassignment', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'workos_org_already_bound'/);
  });

  it('apply_workos_event handles connection.activated, deactivated, deleted (and dsync variants)', () => {
    expect(sql).toMatch(/connection\.activated/);
    expect(sql).toMatch(/connection\.deactivated/);
    expect(sql).toMatch(/connection\.deleted/);
    expect(sql).toMatch(/dsync\.connection\.deleted/);
  });

  it('disable_sso_connection is owner-only', () => {
    expect(sql).toMatch(/disable_sso_connection[\s\S]*v_caller_role\s*<>\s*'owner'/);
  });
});
