// Codex PR-pass WARNING #3 — admin RPC caller-spoofing regression.
//
// Asserts that the route ALWAYS uses the cookie-derived caller user ID,
// never any value the client could pass in a request body. This is the
// invariant that makes the SECURITY DEFINER + p_caller_user_id pattern
// safe across Phases 5.1, 5.2, 5.4, and 5.6.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));

let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const { POST: addDomain } = await import('@/app/api/dashboard/orgs/[orgId]/sso/domains/route');
const { PATCH: setRequired } = await import('@/app/api/dashboard/orgs/[orgId]/sso/required/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

describe('admin RPC caller-spoofing regression (codex PR-pass WARNING #3)', () => {
  it('claim_domain ignores body-supplied callerUserId field; uses cookie session', async () => {
    const orgId = randomUUID();
    const realOwner = randomUUID();
    const fakeAdmin = randomUUID();
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: realOwner, role: 'owner', status: 'active', joined_at: new Date().toISOString() },
      // fakeAdmin is NOT a member.
    ]);
    stub.seed('organizations', [{ id: orgId, name: 'A' }]);
    currentUser = { id: realOwner };

    const r = await addDomain(
      new Request(`http://x/api/dashboard/orgs/${orgId}/sso/domains`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev' },
        body: JSON.stringify({
          domain: 'acme.com',
          // Attacker-supplied spoofed values; route must ignore.
          callerUserId: fakeAdmin,
          p_caller_user_id: fakeAdmin,
        }),
      }),
      { params: { orgId } },
    );
    expect(r.status).toBe(200);
    // The audit row should attribute action to realOwner (cookie), not fakeAdmin (body).
    const audits = stub.tables.get('audit_events')!;
    const claim = audits.find((a) => a.action === 'org.sso.domain.claim_started');
    expect(claim?.actor_user_id).toBe(realOwner);
    expect(claim?.actor_user_id).not.toBe(fakeAdmin);
  });

  it('set_sso_required ignores body-supplied callerUserId; non-owner cookie → 403', async () => {
    const orgId = randomUUID();
    const memberUser = randomUUID();
    const fakeOwner = randomUUID();
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: memberUser, role: 'member', status: 'active', joined_at: new Date().toISOString() },
      // fakeOwner is also not seeded as owner.
    ]);
    stub.seed('organizations', [{ id: orgId, name: 'A' }]);
    stub.seed('organization_settings', [{ organization_id: orgId, sso_connection_status: 'active' }]);
    currentUser = { id: memberUser };

    const r = await setRequired(
      new Request(`http://x/api/dashboard/orgs/${orgId}/sso/required`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev' },
        body: JSON.stringify({
          ssoRequired: true,
          // Spoofed.
          callerUserId: fakeOwner,
          p_caller_user_id: fakeOwner,
        }),
      }),
      { params: { orgId } },
    );
    expect(r.status).toBe(403);
  });
});
