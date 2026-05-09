import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../../../../../data/deltas/20260509140000_phase5_7_lifecycle.sql',
);

describe('Phase 5.7 lifecycle migration privilege model + hardening', () => {
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

  it('all 6 RPC bodies declare SECURITY DEFINER', () => {
    // revoke_user_sessions + disable_member + enable_member +
    // cleanup_expired_sso_states + record_workos_sign_in (REPLACE) +
    // apply_workos_event (REPLACE) = 6.
    const matches = sql.match(/SECURITY DEFINER/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  it('all RPC bodies declare locked search_path', () => {
    const matches = sql.match(/SET\s+search_path\s*=/gi) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  it('memberships status CHECK includes disabled', () => {
    expect(sql).toMatch(/CHECK \(status IN \('pending', 'active', 'inactive', 'disabled'\)\)/);
  });

  it('disabled_at + disabled_by columns added', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS disabled_by UUID/);
  });

  it('record_workos_sign_in raises member_disabled / member_inactive / invite_pending', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'member_disabled'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'member_inactive'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'invite_pending'/);
  });

  it('apply_workos_event has set-based cascade DELETE on auth.refresh_tokens', () => {
    expect(sql).toMatch(/DELETE FROM auth\.refresh_tokens[\s\S]*affected_users/);
  });

  it('cascade scope includes status IN (active, disabled) per plan-pass WARNING #1', () => {
    expect(sql).toMatch(/m\.status IN \('active', 'disabled'\)/);
  });

  it('disable_member has cannot_disable_self + cannot_disable_owner + last_owner guards', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'cannot_disable_self'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'cannot_disable_owner'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'last_owner'/);
  });

  it('disable_member is idempotent on already-disabled (returns noop:true)', () => {
    expect(sql).toMatch(/IF v_target_status = 'disabled' THEN[\s\S]*'noop', true/);
  });

  it('disable_member transitions only from active (codex pass-2 WARNING #2)', () => {
    expect(sql).toMatch(/IF v_target_status <> 'active' THEN[\s\S]*invalid_status_transition/);
  });

  it('enable_member has symmetric owner protection (codex pass-2 WARNING #3)', () => {
    expect(sql).toMatch(/v_target_role = 'owner' AND v_caller_role <> 'owner'[\s\S]*cannot_enable_owner/);
  });

  it('cleanup_expired_sso_states validates argument ranges', () => {
    expect(sql).toMatch(/p_state_age_hours < 1 OR p_state_age_hours > 720/);
    expect(sql).toMatch(/p_event_age_days < 1 OR p_event_age_days > 365/);
  });

  it('disable_member does NOT revoke API keys (codex pass-2 CRITICAL #1 — cross-tenant blast)', () => {
    expect(sql).not.toMatch(/UPDATE public\.api_keys[\s\S]*SET revoked_at/);
    expect(sql).toMatch(/DROPPED API-key revocation/);
  });

  it('disable_member uses pg_advisory_xact_lock per-org (codex PR-pass CRITICAL #3 — last-owner race)', () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtext\('org-lifecycle:'/);
  });
});
