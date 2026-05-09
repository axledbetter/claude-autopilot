import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const { POST } = await import('@/app/api/dashboard/orgs/[orgId]/members/[userId]/enable/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function req(orgId: string, userId: string): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/members/${userId}/enable`, {
    method: 'POST',
    headers: { origin: 'https://autopilot.dev' },
  });
}

function seedDisabledMember(orgId: string, role: 'owner' | 'admin' | 'member' = 'member'): { caller: string; target: string } {
  const owner = randomUUID();
  const target = randomUUID();
  stub.seed('organizations', [{ id: orgId, name: 'A' }]);
  stub.seed('memberships', [
    { id: randomUUID(), organization_id: orgId, user_id: owner, role: 'owner', status: 'active', joined_at: new Date().toISOString() },
    { id: randomUUID(), organization_id: orgId, user_id: target, role, status: 'disabled', joined_at: new Date().toISOString(), disabled_at: new Date().toISOString(), disabled_by: owner },
  ]);
  return { caller: owner, target };
}

describe('POST /api/dashboard/orgs/:orgId/members/:userId/enable', () => {
  it('test 9: owner re-enables disabled admin → 200, status=active, disabled_at cleared', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedDisabledMember(orgId, 'admin');
    currentUser = { id: caller };
    const r = await POST(req(orgId, target), { params: { orgId, userId: target } });
    expect(r.status).toBe(200);
    const memberships = stub.tables.get('memberships') ?? [];
    const m = memberships.find((x) => x.user_id === target);
    expect(m?.status).toBe('active');
    expect(m?.disabled_at).toBe(null);
    expect(m?.disabled_by).toBe(null);
  });

  it('test 10: cannot enable from inactive → 422 invalid_status_transition', async () => {
    const orgId = randomUUID();
    const owner = randomUUID();
    const inactiveUser = randomUUID();
    stub.seed('organizations', [{ id: orgId, name: 'A' }]);
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: owner, role: 'owner', status: 'active', joined_at: new Date().toISOString() },
      { id: randomUUID(), organization_id: orgId, user_id: inactiveUser, role: 'member', status: 'inactive', joined_at: new Date().toISOString() },
    ]);
    currentUser = { id: owner };
    const r = await POST(req(orgId, inactiveUser), { params: { orgId, userId: inactiveUser } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('invalid_status_transition');
  });

  it('codex pass-2 WARNING #3: admin tries to re-enable disabled OWNER → 403 cannot_enable_owner', async () => {
    const orgId = randomUUID();
    const owner1 = randomUUID();
    const disabledOwner = randomUUID();
    const admin = randomUUID();
    stub.seed('organizations', [{ id: orgId, name: 'A' }]);
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: owner1, role: 'owner', status: 'active', joined_at: new Date().toISOString() },
      { id: randomUUID(), organization_id: orgId, user_id: disabledOwner, role: 'owner', status: 'disabled', joined_at: new Date().toISOString() },
      { id: randomUUID(), organization_id: orgId, user_id: admin, role: 'admin', status: 'active', joined_at: new Date().toISOString() },
    ]);
    currentUser = { id: admin };
    const r = await POST(req(orgId, disabledOwner), { params: { orgId, userId: disabledOwner } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('cannot_enable_owner');
  });

  it('owner can re-enable disabled owner', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedDisabledMember(orgId, 'owner');
    currentUser = { id: caller };
    const r = await POST(req(orgId, target), { params: { orgId, userId: target } });
    expect(r.status).toBe(200);
  });
});
