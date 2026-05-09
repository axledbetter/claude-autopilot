import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const createOrgMock = vi.fn();
const generateLinkMock = vi.fn();
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    organizations: { createOrganization: createOrgMock },
    adminPortal: { generateLink: generateLinkMock },
  }),
  verifyWorkOSSignature: async () => ({ ok: false, reason: 'unused' }),
}));

const { POST } = await import('@/app/api/dashboard/orgs/[orgId]/sso/setup/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  createOrgMock.mockReset();
  generateLinkMock.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.WORKOS_API_KEY = 'sk_test_stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function req(orgId: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/sso/setup`, {
    method: 'POST',
    headers: { origin: 'https://autopilot.dev', ...headers },
  });
}

function seedOwner(orgId: string, name = 'Acme'): string {
  const owner = randomUUID();
  stub.seed('memberships', [{
    id: randomUUID(), organization_id: orgId, user_id: owner,
    role: 'owner', status: 'active', joined_at: new Date().toISOString(),
  }]);
  stub.seed('organizations', [{ id: orgId, name }]);
  return owner;
}

describe('POST /api/dashboard/orgs/:orgId/sso/setup', () => {
  it('test 1: owner first-time setup → creates WorkOS org + portal link, status pending', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    currentUser = { id: owner };
    createOrgMock.mockResolvedValue({ id: 'org_workos_111' });
    generateLinkMock.mockResolvedValue({ link: 'https://portal.example/abc' });

    const r = await POST(req(orgId), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.portalUrl).toBe('https://portal.example/abc');
    expect(body.workosOrganizationId).toBe('org_workos_111');
    expect(r.headers.get('cache-control')).toBe('private, no-store');

    expect(createOrgMock).toHaveBeenCalledWith({ name: 'Acme', externalId: orgId });
    const settings = stub.tables.get('organization_settings')!.find((s) => s.organization_id === orgId);
    expect(settings?.workos_organization_id).toBe('org_workos_111');
    expect(settings?.sso_connection_status).toBe('pending');
  });

  it('test 2: idempotent retry — re-uses stored workos_organization_id', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    currentUser = { id: owner };
    stub.seed('organization_settings', [{
      organization_id: orgId,
      workos_organization_id: 'org_workos_existing',
      sso_connection_status: 'pending',
    }]);
    generateLinkMock.mockResolvedValue({ link: 'https://portal.example/again' });

    const r = await POST(req(orgId), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.workosOrganizationId).toBe('org_workos_existing');
    expect(createOrgMock).not.toHaveBeenCalled();
  });

  it('test 3: non-admin → 403 not_admin', async () => {
    const orgId = randomUUID();
    const memberUser = randomUUID();
    stub.seed('memberships', [{
      id: randomUUID(), organization_id: orgId, user_id: memberUser,
      role: 'member', status: 'active', joined_at: new Date().toISOString(),
    }]);
    stub.seed('organizations', [{ id: orgId, name: 'A' }]);
    currentUser = { id: memberUser };
    createOrgMock.mockResolvedValue({ id: 'org_workos_222' });

    const r = await POST(req(orgId), { params: { orgId } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('not_admin');
  });

  it('test 4: unauthenticated → 401', async () => {
    const orgId = randomUUID();
    seedOwner(orgId);
    currentUser = null;
    const r = await POST(req(orgId), { params: { orgId } });
    expect(r.status).toBe(401);
  });

  it('test 5: bad origin → 403', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    currentUser = { id: owner };
    const r = await POST(req(orgId, { origin: 'https://attacker.example' }), { params: { orgId } });
    expect(r.status).toBe(403);
  });

  it('test 6: malformed orgId → 422', async () => {
    currentUser = { id: randomUUID() };
    const r = await POST(req('not-a-uuid'), { params: { orgId: 'not-a-uuid' } });
    expect(r.status).toBe(422);
  });

  it('test 7: org_not_found → 404', async () => {
    const orgId = randomUUID();
    const owner = randomUUID();
    stub.seed('memberships', [{
      id: randomUUID(), organization_id: orgId, user_id: owner,
      role: 'owner', status: 'active', joined_at: new Date().toISOString(),
    }]);
    currentUser = { id: owner };
    const r = await POST(req(orgId), { params: { orgId } });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('org_not_found');
  });

  it('test 8: WorkOS createOrganization fails → 502', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    currentUser = { id: owner };
    createOrgMock.mockRejectedValue(new Error('WorkOS API down'));
    const r = await POST(req(orgId), { params: { orgId } });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe('workos_create_failed');
  });

  it('test 9: re-setup on already-active connection — re-emits portal link, status stays active', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    currentUser = { id: owner };
    stub.seed('organization_settings', [{
      organization_id: orgId,
      workos_organization_id: 'org_workos_existing',
      sso_connection_status: 'active',
    }]);
    generateLinkMock.mockResolvedValue({ link: 'https://portal.example/reconfig' });

    const r = await POST(req(orgId), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.workosOrganizationId).toBe('org_workos_existing');
    expect(body.portalUrl).toBe('https://portal.example/reconfig');
    // Status should stay active.
    const settings = stub.tables.get('organization_settings')!.find((s) => s.organization_id === orgId);
    expect(settings?.sso_connection_status).toBe('active');
    expect(createOrgMock).not.toHaveBeenCalled();
  });

  it('test 9b: RPC reassignment guard — direct call w/ different active workos org → workos_org_already_bound', async () => {
    // The route can't trigger this (it always reuses the stored id), so
    // verify the RPC contract directly. This is the security boundary
    // that protects against the 'swap an active SSO connection' attack.
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    stub.seed('organization_settings', [{
      organization_id: orgId,
      workos_organization_id: 'org_workos_OLD',
      sso_connection_status: 'active',
    }]);
    const client = stub.asClient();
    const { error } = await client.rpc('record_sso_setup_initiated', {
      p_caller_user_id: owner,
      p_org_id: orgId,
      p_workos_organization_id: 'org_workos_NEW',
    });
    expect(error?.message).toBe('workos_org_already_bound');
  });

  it('test 10: portal link failure → 502', async () => {
    const orgId = randomUUID();
    const owner = seedOwner(orgId);
    currentUser = { id: owner };
    createOrgMock.mockResolvedValue({ id: 'org_workos_111' });
    generateLinkMock.mockRejectedValue(new Error('Portal API timeout'));
    const r = await POST(req(orgId), { params: { orgId } });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe('portal_link_failed');
  });
});
