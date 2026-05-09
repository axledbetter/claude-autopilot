// Phase 5.7 — codex plan-pass CRITICAL #2 regression.
//
// Proves the spec's "disabled-state enforcement audit" table is correct:
// every org-scoped path already excludes status='disabled' via Phase 1's
// SECURITY DEFINER membership helpers or Phase 5.x RPC-level checks.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const { GET: getAudit } = await import('@/app/api/dashboard/orgs/[orgId]/audit/route');
const { PATCH: patchOrg } = await import('@/app/api/dashboard/orgs/[orgId]/route');
const { POST: ssoSetup } = await import('@/app/api/dashboard/orgs/[orgId]/sso/setup/route');
const { POST: invite } = await import('@/app/api/dashboard/orgs/[orgId]/members/invite/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.WORKOS_API_KEY = 'sk_test_stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

describe('Disabled member with still-valid JWT cannot access org-scoped routes', () => {
  // Setup: an org with one owner + one previously-admin member who is now disabled.
  // The disabled user's JWT (cookie session) is still valid in the test
  // (resolveSessionUserId returns their userId).
  function setup(): { orgId: string; disabledUser: string } {
    const orgId = randomUUID();
    const owner = randomUUID();
    const disabledUser = randomUUID();
    stub.seed('organizations', [{ id: orgId, name: 'Acme' }]);
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: owner, role: 'owner', status: 'active', joined_at: new Date().toISOString() },
      { id: randomUUID(), organization_id: orgId, user_id: disabledUser, role: 'admin', status: 'disabled', joined_at: new Date().toISOString() },
    ]);
    return { orgId, disabledUser };
  }

  it('GET audit → 404 not_found (route intentionally maps not_admin → 404 to not leak org existence)', async () => {
    const { orgId, disabledUser } = setup();
    currentUser = { id: disabledUser };
    const r = await getAudit(
      new Request(`http://x/api/dashboard/orgs/${orgId}/audit`, {
        method: 'GET', headers: { origin: 'https://autopilot.dev' },
      }),
      { params: { orgId } },
    );
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('not_found');
  });

  it('PATCH org name → 403 not_owner', async () => {
    const { orgId, disabledUser } = setup();
    currentUser = { id: disabledUser };
    const r = await patchOrg(
      new Request(`http://x/api/dashboard/orgs/${orgId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev' },
        body: JSON.stringify({ name: 'New' }),
      }),
      { params: { orgId } },
    );
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('not_owner');
  });

  it('POST sso/setup → 403 not_admin', async () => {
    const { orgId, disabledUser } = setup();
    currentUser = { id: disabledUser };
    const r = await ssoSetup(
      new Request(`http://x/api/dashboard/orgs/${orgId}/sso/setup`, {
        method: 'POST', headers: { origin: 'https://autopilot.dev' },
      }),
      { params: { orgId } },
    );
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('not_admin');
  });

  it('POST member invite → 403 not_admin', async () => {
    const { orgId, disabledUser } = setup();
    currentUser = { id: disabledUser };
    const r = await invite(
      new Request(`http://x/api/dashboard/orgs/${orgId}/members/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev' },
        body: JSON.stringify({ email: 'new@acme.com', role: 'member' }),
      }),
      { params: { orgId } },
    );
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('not_admin');
  });
});
