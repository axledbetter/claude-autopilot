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

const { PATCH } = await import('@/app/api/dashboard/orgs/[orgId]/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function req(orgId: string, body: object, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev', ...headers },
    body: JSON.stringify(body),
  });
}

function seedOwner(orgId: string, name = 'Old Name'): string {
  const owner = randomUUID();
  stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: owner, role: 'owner', status: 'active', joined_at: new Date().toISOString() }]);
  stub.seed('organizations', [{ id: orgId, name }]);
  return owner;
}

describe('PATCH /api/dashboard/orgs/:orgId', () => {
  it('test 25: owner updates name → 200', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    currentUser = { id: owner };
    const r = await PATCH(req(orgId, { name: 'Acme Corp' }), { params: { orgId } });
    expect(r.status).toBe(200);
    expect(stub.tables.get('organizations')!.find((o) => o.id === orgId)!.name).toBe('Acme Corp');
  });

  it('test 26: admin → 403 not_owner', async () => {
    const orgId = randomUUID();
    const admin = randomUUID();
    stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: admin, role: 'admin', status: 'active', joined_at: new Date().toISOString() }]);
    stub.seed('organizations', [{ id: orgId, name: 'X' }]);
    currentUser = { id: admin };
    const r = await PATCH(req(orgId, { name: 'Y' }), { params: { orgId } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('not_owner');
  });

  it('test 26b: non-member → 403 not_owner (NULL-role guard)', async () => {
    const orgId = randomUUID();
    const ghost = randomUUID();
    stub.seed('organizations', [{ id: orgId, name: 'X' }]);
    currentUser = { id: ghost };
    const r = await PATCH(req(orgId, { name: 'Y' }), { params: { orgId } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('not_owner');
  });

  it('test 27: whitespace name → 422 bad_name', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    currentUser = { id: owner };
    const r = await PATCH(req(orgId, { name: '   ' }), { params: { orgId } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('bad_name');
  });

  it('test 28: name > 100 chars → 422 bad_name', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    currentUser = { id: owner };
    const r = await PATCH(req(orgId, { name: 'x'.repeat(101) }), { params: { orgId } });
    expect(r.status).toBe(422);
  });

  it('codex-pr: non-existent org → 404 org_not_found', async () => {
    const orgId = randomUUID();
    const owner = randomUUID();
    stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: owner, role: 'owner', status: 'active', joined_at: new Date().toISOString() }]);
    // No organizations row seeded.
    currentUser = { id: owner };
    const r = await PATCH(req(orgId, { name: 'New' }), { params: { orgId } });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('org_not_found');
  });

  it('codex-pr: malformed orgId → 422 malformed_params', async () => {
    currentUser = { id: randomUUID() };
    const r = await PATCH(req('not-a-uuid', { name: 'New' }), { params: { orgId: 'not-a-uuid' } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('malformed_params');
  });

  it('test 29: bad origin → 403', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    currentUser = { id: owner };
    const r = await PATCH(req(orgId, { name: 'Acme' }, { origin: 'https://attacker.example' }), { params: { orgId } });
    expect(r.status).toBe(403);
  });
});
