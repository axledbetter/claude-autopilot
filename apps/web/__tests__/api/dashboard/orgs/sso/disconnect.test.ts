import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const deleteConnectionMock = vi.fn();
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ sso: { deleteConnection: deleteConnectionMock } }),
  verifyWorkOSSignature: async () => ({ ok: false, reason: 'unused' }),
}));

const { DELETE } = await import('@/app/api/dashboard/orgs/[orgId]/sso/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  deleteConnectionMock.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.WORKOS_API_KEY = 'sk_test_stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function req(orgId: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/sso`, {
    method: 'DELETE',
    headers: { origin: 'https://autopilot.dev', ...headers },
  });
}

function seedActive(orgId: string, role: 'owner' | 'admin' = 'owner'): string {
  const userId = randomUUID();
  stub.seed('memberships', [{
    id: randomUUID(), organization_id: orgId, user_id: userId,
    role, status: 'active', joined_at: new Date().toISOString(),
  }]);
  stub.seed('organizations', [{ id: orgId, name: 'A' }]);
  stub.seed('organization_settings', [{
    organization_id: orgId,
    workos_organization_id: 'org_workos_111',
    workos_connection_id: 'conn_111',
    sso_connection_status: 'active',
  }]);
  return userId;
}

describe('DELETE /api/dashboard/orgs/:orgId/sso', () => {
  it('test 11: owner active → status disabled, WorkOS DELETE called', async () => {
    const orgId = randomUUID();
    const owner = seedActive(orgId, 'owner');
    currentUser = { id: owner };
    deleteConnectionMock.mockResolvedValue({});
    const r = await DELETE(req(orgId), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('disabled');
    expect(body.workosConnectionId).toBe('conn_111');
    expect(body.workosDeleted).toBe(true);
    expect(deleteConnectionMock).toHaveBeenCalledWith('conn_111');
  });

  it('test 12: admin (not owner) → 403 not_owner', async () => {
    const orgId = randomUUID();
    const admin = seedActive(orgId, 'admin');
    currentUser = { id: admin };
    const r = await DELETE(req(orgId), { params: { orgId } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('not_owner');
  });

  it('test 13: idempotent — already disabled → 200 noop, no WorkOS call', async () => {
    const orgId = randomUUID();
    const owner = seedActive(orgId, 'owner');
    const settings = stub.tables.get('organization_settings')!;
    settings[0]!.sso_connection_status = 'disabled';
    currentUser = { id: owner };
    const r = await DELETE(req(orgId), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.noop).toBe(true);
    expect(deleteConnectionMock).not.toHaveBeenCalled();
  });

  it('test 14: WorkOS DELETE fails → still 200, status disabled, workosDeleted=false', async () => {
    const orgId = randomUUID();
    const owner = seedActive(orgId, 'owner');
    currentUser = { id: owner };
    deleteConnectionMock.mockRejectedValue(new Error('WorkOS 503'));
    const r = await DELETE(req(orgId), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('disabled');
    expect(body.workosDeleted).toBe(false);
    expect(body.workosError).toContain('503');
  });

  it('test 15: bad origin → 403', async () => {
    const orgId = randomUUID();
    const owner = seedActive(orgId, 'owner');
    currentUser = { id: owner };
    const r = await DELETE(req(orgId, { origin: 'https://attacker.example' }), { params: { orgId } });
    expect(r.status).toBe(403);
  });

  it('test 16: unauthenticated → 401', async () => {
    const orgId = randomUUID();
    seedActive(orgId, 'owner');
    currentUser = null;
    const r = await DELETE(req(orgId), { params: { orgId } });
    expect(r.status).toBe(401);
  });
});
