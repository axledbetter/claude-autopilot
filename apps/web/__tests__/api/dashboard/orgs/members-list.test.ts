import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));

const { GET } = await import('@/app/api/dashboard/orgs/[orgId]/members/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
});

function req(orgId: string): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/members`);
}

describe('GET /api/dashboard/orgs/:orgId/members', () => {
  it('test 1: active member sees own org roster with emails', async () => {
    const orgId = randomUUID();
    const me = randomUUID();
    const peer = randomUUID();
    currentUser = { id: me };
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: me, role: 'admin', status: 'active', joined_at: new Date().toISOString() },
      { id: randomUUID(), organization_id: orgId, user_id: peer, role: 'member', status: 'active', joined_at: new Date().toISOString() },
    ]);
    stub.seed('auth.users', [
      { id: me, email: 'me@autopilot.dev' },
      { id: peer, email: 'peer@autopilot.dev' },
    ]);
    const r = await GET(req(orgId), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.members.length).toBe(2);
    const meRow = body.members.find((m: { userId: string }) => m.userId === me);
    expect(meRow.email).toBe('me@autopilot.dev');
  });

  it('test 2: non-member → 403 no_membership (v7.5.0 helper short-circuits before RPC)', async () => {
    // Pre-v7.5.0 the route returned 404 to avoid org enumeration. The
    // new helper returns 403 with body `{error:'no_membership'}` which
    // is also non-enumerating: the same response shape fires whether
    // the org exists or not.
    const orgId = randomUUID();
    currentUser = { id: randomUUID() };
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: randomUUID(), role: 'owner', status: 'active', joined_at: new Date().toISOString() },
    ]);
    const r = await GET(req(orgId), { params: { orgId } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('no_membership');
  });

  it('test 3: not signed in → 401', async () => {
    const orgId = randomUUID();
    const r = await GET(req(orgId), { params: { orgId } });
    expect(r.status).toBe(401);
  });
});
