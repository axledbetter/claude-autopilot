import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../../../../../data/deltas/20260509120000_phase5_6_workos_signin.sql',
);

describe('Phase 5.6 SSO sign-in migration privilege model + hardening', () => {
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

  it('all 6 RPCs declare SECURITY DEFINER', () => {
    const matches = sql.match(/SECURITY DEFINER/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  it('all RPCs declare locked search_path', () => {
    const matches = sql.match(/SET\s+search_path\s*=\s*public/gi) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  it('schema-qualified references — public.organization_domain_claims, public.organization_settings, audit.append', () => {
    expect(sql).toMatch(/public\.organization_domain_claims/);
    expect(sql).toMatch(/public\.organization_settings/);
    expect(sql).toMatch(/audit\.append/);
  });

  it('unique partial index on (lower(domain)) WHERE ever_verified = TRUE — codex CRITICAL #1', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^\n]*organization_domain_claims_owned_domain_idx/);
    expect(sql).toMatch(/WHERE ever_verified = TRUE/);
  });

  it('record_workos_sign_in raises email_domain_not_claimed_for_org', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'email_domain_not_claimed_for_org'/);
  });

  it('consume_sso_authentication_state distinguishes 5 negative states', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'state_not_found'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'state_expired'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'state_already_consumed'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'state_nonce_mismatch'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'state_workos_org_mismatch'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'state_workos_connection_mismatch'/);
  });

  it('consume_sso_authentication_state uses atomic UPDATE...RETURNING — codex plan-pass WARNING #5', () => {
    expect(sql).toMatch(/UPDATE public\.sso_authentication_states[\s\S]*SET consumed_at = NOW\(\)[\s\S]*WHERE id = p_state_id[\s\S]*AND consumed_at IS NULL[\s\S]*RETURNING/);
  });

  it('set_sso_required asymmetric guard — TRUE requires active SSO; FALSE always allowed', () => {
    expect(sql).toMatch(/IF p_required = TRUE AND COALESCE\(v_current_status, 'inactive'\) <> 'active' THEN[\s\S]*'no_active_sso'/);
  });

  it('claim_domain blocks domain_already_claimed when ever_verified TRUE in another org', () => {
    expect(sql).toMatch(/ever_verified = TRUE[\s\S]*organization_id <> p_org_id[\s\S]*'domain_already_claimed'/);
  });

  it('revoke_domain_claim preserves ever_verified — codex CRITICAL #1', () => {
    expect(sql).toMatch(/ever_verified deliberately preserved/i);
  });
});
