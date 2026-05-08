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

const { DELETE } = await import('@/app/api/dashboard/orgs/[orgId]/members/[userId]/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function req(orgId: string, userId: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/members/${userId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev', ...headers },
  });
}

function seedTwo(orgId: string, callerRole: string, targetRole: string): { caller: string; target: string } {
  const caller = randomUUID(); const target = randomUUID();
  stub.seed('memberships', [
    { id: randomUUID(), organization_id: orgId, user_id: caller, role: callerRole, status: 'active', joined_at: new Date().toISOString() },
    { id: randomUUID(), organization_id: orgId, user_id: target, role: targetRole, status: 'active', joined_at: new Date().toISOString() },
  ]);
  return { caller, target };
}

describe('DELETE /api/dashboard/orgs/:orgId/members/:userId', () => {
  it('test 19: admin removes member → 200, status=removed, audit emitted', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwo(orgId, 'admin', 'member');
    currentUser = { id: caller };
    const r = await DELETE(req(orgId, target), { params: { orgId, userId: target } });
    expect(r.status).toBe(200);
    const row = stub.tables.get('memberships')!.find((m) => m.user_id === target)!;
    expect(row.status).toBe('removed');
    const audits = (stub.tables.get('audit_events') ?? []).filter((a) => a.action === 'org.member.removed');
    expect(audits.length).toBe(1);
  });

  it('test 20: admin removes admin → 403 not_owner', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwo(orgId, 'admin', 'admin');
    currentUser = { id: caller };
    const r = await DELETE(req(orgId, target), { params: { orgId, userId: target } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('not_owner');
  });

  it('test 21: owner removes last owner → 422 last_owner', async () => {
    const orgId = randomUUID();
    const { caller } = seedTwo(orgId, 'owner', 'member');
    currentUser = { id: caller };
    const r = await DELETE(req(orgId, caller), { params: { orgId, userId: caller } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('last_owner');
  });

  it('test 22: owner removes one of two owners → 200', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwo(orgId, 'owner', 'owner');
    currentUser = { id: caller };
    const r = await DELETE(req(orgId, target), { params: { orgId, userId: target } });
    expect(r.status).toBe(200);
  });

  it('test 23: target already removed → 404 target_not_member', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwo(orgId, 'admin', 'member');
    const targetRow = stub.tables.get('memberships')!.find((m) => m.user_id === target)!;
    targetRow.status = 'removed';
    currentUser = { id: caller };
    const r = await DELETE(req(orgId, target), { params: { orgId, userId: target } });
    expect(r.status).toBe(404);
  });

  it('test 24: DELETE bad origin → 403', async () => {
    const orgId = randomUUID();
    const { caller, target } = seedTwo(orgId, 'admin', 'member');
    currentUser = { id: caller };
    const r = await DELETE(req(orgId, target, { origin: 'https://attacker.example' }), { params: { orgId, userId: target } });
    expect(r.status).toBe(403);
  });
});
