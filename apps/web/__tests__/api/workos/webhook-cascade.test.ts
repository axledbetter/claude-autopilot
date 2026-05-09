// Phase 5.7 — SSO disconnect cascade tests.
// Codex plan-pass WARNING #1 — cascade includes 'active' AND 'disabled' members.
// Codex plan-pass WARNING #5 — audit metadata has counts only, no user IDs.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));

let nextVerifyResult: { ok: true; event: { id: string; event: string; data: Record<string, unknown>; createdAt: string } } | { ok: false; reason: string } = { ok: false, reason: 'init' };
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({}),
  verifyWorkOSSignature: async () => nextVerifyResult,
}));

const { POST } = await import('@/app/api/workos/webhook/route');

beforeEach(() => {
  stub.reset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.WORKOS_API_KEY = 'sk_test_stub';
  process.env.WORKOS_WEBHOOK_SECRET = 'whsec_stub';
});

function req(): Request {
  return new Request('http://x/api/workos/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'workos-signature': 't=1,v1=stub' },
    body: '{}',
  });
}

interface SeedResult {
  orgId: string;
  activeMatchedUserId: string;
  disabledMatchedUserId: string;
  unmatchedDomainUserId: string;
  inactiveMatchedUserId: string;
}

function seedCascadeFixture(): SeedResult {
  const orgId = randomUUID();
  const activeMatched = randomUUID();
  const disabledMatched = randomUUID();
  const unmatchedDomain = randomUUID();
  const inactiveMatched = randomUUID();
  stub.seed('organizations', [{ id: orgId, name: 'Acme' }]);
  stub.seed('organization_settings', [{
    organization_id: orgId,
    workos_organization_id: 'org_workos_111',
    workos_connection_id: 'conn_111',
    sso_connection_status: 'active',
    sso_last_workos_event_at: null,
  }]);
  stub.seed('organization_domain_claims', [{
    id: randomUUID(),
    organization_id: orgId,
    domain: 'acme.com',
    status: 'verified',
    ever_verified: true,
    challenge_token: 'a'.repeat(64),
    verified_at: new Date().toISOString(),
  }]);
  stub.seed('auth.users', [
    { id: activeMatched, email: 'alice@acme.com' },
    { id: disabledMatched, email: 'bob@acme.com' },
    { id: unmatchedDomain, email: 'carol@other.com' },
    { id: inactiveMatched, email: 'dave@acme.com' },
  ]);
  stub.seed('memberships', [
    { id: randomUUID(), organization_id: orgId, user_id: activeMatched, role: 'member', status: 'active', joined_at: new Date().toISOString() },
    { id: randomUUID(), organization_id: orgId, user_id: disabledMatched, role: 'member', status: 'disabled', joined_at: new Date().toISOString() },
    { id: randomUUID(), organization_id: orgId, user_id: unmatchedDomain, role: 'member', status: 'active', joined_at: new Date().toISOString() },
    { id: randomUUID(), organization_id: orgId, user_id: inactiveMatched, role: 'member', status: 'inactive', joined_at: new Date().toISOString() },
  ]);
  // Seed refresh tokens for everyone.
  stub.seed('auth.refresh_tokens', [
    { id: randomUUID(), user_id: activeMatched, created_at: new Date().toISOString() },
    { id: randomUUID(), user_id: activeMatched, created_at: new Date().toISOString() },
    { id: randomUUID(), user_id: disabledMatched, created_at: new Date().toISOString() },
    { id: randomUUID(), user_id: unmatchedDomain, created_at: new Date().toISOString() },
    { id: randomUUID(), user_id: inactiveMatched, created_at: new Date().toISOString() },
  ]);
  return {
    orgId,
    activeMatchedUserId: activeMatched,
    disabledMatchedUserId: disabledMatched,
    unmatchedDomainUserId: unmatchedDomain,
    inactiveMatchedUserId: inactiveMatched,
  };
}

describe('SSO disconnect cascade (apply_workos_event connection.deleted)', () => {
  it('test 13 — cascade revokes refresh tokens for active AND disabled members with verified-domain emails', async () => {
    const fx = seedCascadeFixture();
    nextVerifyResult = {
      ok: true,
      event: {
        id: 'evt_del_1', event: 'connection.deleted',
        data: { organization_id: 'org_workos_111', id: 'conn_111' },
        createdAt: new Date().toISOString(),
      },
    };
    const r = await POST(req());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.cascadeRevokedUserCount).toBe(2);  // activeMatched + disabledMatched
    expect(body.cascadeRevokedTokenCount).toBe(3);  // 2 + 1
    const tokens = stub.tables.get('auth.refresh_tokens') ?? [];
    expect(tokens.find((t) => t.user_id === fx.activeMatchedUserId)).toBeUndefined();
    expect(tokens.find((t) => t.user_id === fx.disabledMatchedUserId)).toBeUndefined();
  });

  it('test 14 — non-verified-domain members keep their tokens', async () => {
    const fx = seedCascadeFixture();
    nextVerifyResult = {
      ok: true,
      event: {
        id: 'evt_del_2', event: 'connection.deleted',
        data: { organization_id: 'org_workos_111', id: 'conn_111' },
        createdAt: new Date().toISOString(),
      },
    };
    await POST(req());
    const tokens = stub.tables.get('auth.refresh_tokens') ?? [];
    expect(tokens.find((t) => t.user_id === fx.unmatchedDomainUserId)).toBeTruthy();
  });

  it('test 14b — inactive members are NOT included in cascade (status filter active+disabled only)', async () => {
    const fx = seedCascadeFixture();
    nextVerifyResult = {
      ok: true,
      event: {
        id: 'evt_del_3', event: 'connection.deleted',
        data: { organization_id: 'org_workos_111', id: 'conn_111' },
        createdAt: new Date().toISOString(),
      },
    };
    await POST(req());
    const tokens = stub.tables.get('auth.refresh_tokens') ?? [];
    expect(tokens.find((t) => t.user_id === fx.inactiveMatchedUserId)).toBeTruthy();
  });

  it('test 15 — audit metadata has cascadeRevokedUserCount + cascadeRevokedTokenCount; no user IDs (codex plan WARNING #5)', async () => {
    seedCascadeFixture();
    nextVerifyResult = {
      ok: true,
      event: {
        id: 'evt_del_4', event: 'connection.deleted',
        data: { organization_id: 'org_workos_111', id: 'conn_111' },
        createdAt: new Date().toISOString(),
      },
    };
    await POST(req());
    const audit = (stub.tables.get('audit_events') ?? []).find((a) => a.action === 'org.sso.lifecycle');
    expect(audit?.metadata).toMatchObject({
      cascadeRevokedUserCount: 2,
      cascadeRevokedTokenCount: 3,
    });
    const meta = audit?.metadata as Record<string, unknown>;
    // Regression: no user-id-shaped fields.
    expect(meta.cascadeRevokedUserIds).toBeUndefined();
    expect(meta.cascadeRevokedUserIdsSample).toBeUndefined();
  });

  it('non-deleted events do NOT trigger cascade', async () => {
    seedCascadeFixture();
    nextVerifyResult = {
      ok: true,
      event: {
        id: 'evt_act_1', event: 'connection.activated',
        data: { organization_id: 'org_workos_111', id: 'conn_111' },
        createdAt: new Date().toISOString(),
      },
    };
    const r = await POST(req());
    const body = await r.json();
    expect(body.cascadeRevokedUserCount).toBe(0);
    expect(body.cascadeRevokedTokenCount).toBe(0);
  });
});
