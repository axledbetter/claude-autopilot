import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const { PATCH } = await import('@/app/api/dashboard/orgs/[orgId]/sso/required/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function req(orgId: string, body: object): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/sso/required`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev' },
    body: JSON.stringify(body),
  });
}

function seedOwner(orgId: string, status: string): string {
  const userId = randomUUID();
  stub.seed('memberships', [{
    id: randomUUID(), organization_id: orgId, user_id: userId,
    role: 'owner', status: 'active', joined_at: new Date().toISOString(),
  }]);
  stub.seed('organizations', [{ id: orgId, name: 'A' }]);
  stub.seed('organization_settings', [{
    organization_id: orgId, sso_connection_status: status, sso_required: false,
  }]);
  return userId;
}

describe('PATCH sso/required', () => {
  it('owner toggle ON when SSO active → 200', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId, 'active');
    currentUser = { id: owner };
    const r = await PATCH(req(orgId, { ssoRequired: true }), { params: { orgId } });
    expect(r.status).toBe(200);
    const settings = stub.tables.get('organization_settings')!.find((s) => s.organization_id === orgId);
    expect(settings?.sso_required).toBe(true);
  });

  it('owner toggle ON when SSO inactive → 422 no_active_sso', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId, 'inactive');
    currentUser = { id: owner };
    const r = await PATCH(req(orgId, { ssoRequired: true }), { params: { orgId } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('no_active_sso');
  });

  it('asymmetric guard: owner toggle OFF when SSO inactive → 200 (codex pass-1 WARNING #7)', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId, 'disabled');
    // Pre-seed sso_required=true.
    stub.tables.get('organization_settings')![0]!.sso_required = true;
    currentUser = { id: owner };
    const r = await PATCH(req(orgId, { ssoRequired: false }), { params: { orgId } });
    expect(r.status).toBe(200);
    const settings = stub.tables.get('organization_settings')!.find((s) => s.organization_id === orgId);
    expect(settings?.sso_required).toBe(false);
  });

  it('admin (not owner) → 403 not_owner', async () => {
    const orgId = randomUUID();
    const adminUser = randomUUID();
    stub.seed('memberships', [{
      id: randomUUID(), organization_id: orgId, user_id: adminUser,
      role: 'admin', status: 'active', joined_at: new Date().toISOString(),
    }]);
    stub.seed('organizations', [{ id: orgId, name: 'A' }]);
    stub.seed('organization_settings', [{ organization_id: orgId, sso_connection_status: 'active' }]);
    currentUser = { id: adminUser };
    const r = await PATCH(req(orgId, { ssoRequired: true }), { params: { orgId } });
    expect(r.status).toBe(403);
  });
});
