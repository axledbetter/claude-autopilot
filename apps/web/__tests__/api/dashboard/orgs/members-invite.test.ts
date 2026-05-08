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

const { POST } = await import('@/app/api/dashboard/orgs/[orgId]/members/invite/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function req(orgId: string, body: object, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/members/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev', ...headers },
    body: JSON.stringify(body),
  });
}

function seedAdmin(orgId: string): { admin: string } {
  const admin = randomUUID();
  stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: admin, role: 'admin', status: 'active', joined_at: new Date().toISOString() }]);
  return { admin };
}

describe('POST /api/dashboard/orgs/:orgId/members/invite', () => {
  it('test 4: admin invites existing user → 200 + audit', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    stub.seed('auth.users', [{ id: randomUUID(), email: 'foo@example.com' }]);
    const r = await POST(req(orgId, { email: 'foo@example.com', role: 'member' }), { params: { orgId } });
    expect(r.status).toBe(200);
    const audits = (stub.tables.get('audit_events') ?? []).filter((a) => a.action === 'org.member.invited');
    expect(audits.length).toBe(1);
  });

  it('test 5: admin invites as owner → 422 bad_role', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    stub.seed('auth.users', [{ id: randomUUID(), email: 'foo@example.com' }]);
    const r = await POST(req(orgId, { email: 'foo@example.com', role: 'owner' }), { params: { orgId } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('bad_role');
  });

  it('test 6: member tries to invite → 403 not_admin', async () => {
    const orgId = randomUUID();
    const me = randomUUID();
    stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: me, role: 'member', status: 'active', joined_at: new Date().toISOString() }]);
    currentUser = { id: me };
    stub.seed('auth.users', [{ id: randomUUID(), email: 'foo@example.com' }]);
    const r = await POST(req(orgId, { email: 'foo@example.com', role: 'member' }), { params: { orgId } });
    expect(r.status).toBe(403);
  });

  it('test 7: unknown email → 404 user_not_found', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    stub.seed('auth.users', []);
    const r = await POST(req(orgId, { email: 'ghost@example.com', role: 'member' }), { params: { orgId } });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('user_not_found');
  });

  it('test 8: already-active member → 409 already_member', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    const inviteeId = randomUUID();
    stub.seed('auth.users', [{ id: inviteeId, email: 'foo@example.com' }]);
    stub.tables.get('memberships')!.push({ id: randomUUID(), organization_id: orgId, user_id: inviteeId, role: 'member', status: 'active', joined_at: new Date().toISOString() });
    const r = await POST(req(orgId, { email: 'foo@example.com', role: 'member' }), { params: { orgId } });
    expect(r.status).toBe(409);
  });

  it('test 9: previously-removed member reactivated → 200 with previousStatus', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    const inviteeId = randomUUID();
    stub.seed('auth.users', [{ id: inviteeId, email: 'foo@example.com' }]);
    stub.tables.get('memberships')!.push({ id: randomUUID(), organization_id: orgId, user_id: inviteeId, role: 'member', status: 'removed', joined_at: '2026-01-01' });
    const r = await POST(req(orgId, { email: 'foo@example.com', role: 'admin' }), { params: { orgId } });
    expect(r.status).toBe(200);
    const row = stub.tables.get('memberships')!.find((m) => m.user_id === inviteeId)!;
    expect(row.status).toBe('active');
    expect(row.role).toBe('admin');
    const audit = (stub.tables.get('audit_events') ?? []).find((a) => a.action === 'org.member.invited');
    expect((audit?.metadata as { previousStatus?: string }).previousStatus).toBe('removed');
  });

  it('test 10: mismatched origin → 403', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    stub.seed('auth.users', [{ id: randomUUID(), email: 'foo@example.com' }]);
    const r = await POST(req(orgId, { email: 'foo@example.com', role: 'member' }, { origin: 'https://attacker.example' }), { params: { orgId } });
    expect(r.status).toBe(403);
  });

  it('test 30: case-insensitive email match', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    stub.seed('auth.users', [{ id: randomUUID(), email: 'foo@example.com' }]);
    const r = await POST(req(orgId, { email: 'Foo@Example.com', role: 'member' }), { params: { orgId } });
    expect(r.status).toBe(200);
  });
});
