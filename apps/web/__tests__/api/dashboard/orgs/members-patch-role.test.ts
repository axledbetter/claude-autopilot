import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));
vi.mock('@/lib/billing/plan-map', () => ({
  loadPublicBillingConfig: () => ({ AUTOPILOT_PUBLIC_BASE_URL: 'https://autopilot.dev' }),
}));

const { PATCH } = await import('@/app/api/dashboard/orgs/[orgId]/members/[userId]/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function req(orgId: string, userId: string, body: object, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/members/${userId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev', ...headers },
    body: JSON.stringify(body),
  });
}

function seedTwoUsers(orgId: string, callerRole: string, targetRole: string): { caller: string; target: string } {
  const caller = randomUUID();
  const target = randomUUID();
  stub.seed('memberships', [
    { id: randomUUID(), organization_id: orgId, user_id: caller, role: callerRole, status: 'active', joined_at: new Date().toISOString() },
    { id: randomUUID(), organization_id: orgId, user_id: target, role: targetRole, status: 'active', joined_at: new Date().toISOString() },
  ]);
  return { caller, target };
}

describe('PATCH /api/dashboard/orgs/:orgId/members/:userId', () => {
  it('test 11: admin promotes member → admin → 200', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwoUsers(orgId, 'admin', 'member');
    currentUser = { id: caller };
    const r = await PATCH(req(orgId, target, { role: 'admin' }), { params: { orgId, userId: target } });
    expect(r.status).toBe(200);
    const row = stub.tables.get('memberships')!.find((m) => m.user_id === target)!;
    expect(row.role).toBe('admin');
  });

  it('test 12: admin promotes another admin → owner → 422 role_transition', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwoUsers(orgId, 'admin', 'admin');
    currentUser = { id: caller };
    const r = await PATCH(req(orgId, target, { role: 'owner' }), { params: { orgId, userId: target } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('role_transition');
  });

  it('test 13: owner promotes admin → owner → 200', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwoUsers(orgId, 'owner', 'admin');
    currentUser = { id: caller };
    const r = await PATCH(req(orgId, target, { role: 'owner' }), { params: { orgId, userId: target } });
    expect(r.status).toBe(200);
    const row = stub.tables.get('memberships')!.find((m) => m.user_id === target)!;
    expect(row.role).toBe('owner');
  });

  it('test 14: owner demotes last owner → 422 last_owner', async () => {
    const orgId = randomUUID();
    const { caller } = seedTwoUsers(orgId, 'owner', 'member'); // only 1 owner
    currentUser = { id: caller };
    const r = await PATCH(req(orgId, caller, { role: 'admin' }), { params: { orgId, userId: caller } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('last_owner');
  });

  it('test 15: target not member → 404 target_not_member', async () => {
    const orgId = randomUUID();
    const { caller } = seedTwoUsers(orgId, 'admin', 'member');
    currentUser = { id: caller };
    const r = await PATCH(req(orgId, randomUUID(), { role: 'admin' }), { params: { orgId, userId: randomUUID() } });
    expect(r.status).toBe(404);
  });

  it('test 16: admin same-role no-op → 200 noop:true, no audit', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwoUsers(orgId, 'admin', 'admin');
    currentUser = { id: caller };
    const r = await PATCH(req(orgId, target, { role: 'admin' }), { params: { orgId, userId: target } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.noop).toBe(true);
    const audits = (stub.tables.get('audit_events') ?? []).filter((a) => a.action === 'org.member.role_changed');
    expect(audits.length).toBe(0);
  });

  it('test 17: PATCH bad origin → 403', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwoUsers(orgId, 'admin', 'member');
    currentUser = { id: caller };
    const r = await PATCH(req(orgId, target, { role: 'admin' }, { origin: 'https://attacker.example' }), { params: { orgId, userId: target } });
    expect(r.status).toBe(403);
  });

  it('test 18: admin demotes another admin → member → 200', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwoUsers(orgId, 'admin', 'admin');
    currentUser = { id: caller };
    const r = await PATCH(req(orgId, target, { role: 'member' }), { params: { orgId, userId: target } });
    expect(r.status).toBe(200);
    const row = stub.tables.get('memberships')!.find((m) => m.user_id === target)!;
    expect(row.role).toBe('member');
  });
});
