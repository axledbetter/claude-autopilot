import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));

const getAuthorizationUrlMock = vi.fn();
class FakeWorkOS {
  sso = { getAuthorizationUrl: getAuthorizationUrlMock };
  webhooks = { constructEvent: vi.fn() };
  organizations = {};
  adminPortal = {};
}
vi.mock('@workos-inc/node', () => ({ WorkOS: FakeWorkOS }));

const { POST } = await import('@/app/api/auth/sso/start/route');

beforeEach(() => {
  stub.reset();
  getAuthorizationUrlMock.mockReset();
  getAuthorizationUrlMock.mockReturnValue('https://api.workos.com/sso/authorize?stub=1');
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.WORKOS_API_KEY = 'sk_test_stub';
  process.env.WORKOS_CLIENT_ID = 'client_test_stub';
  process.env.SSO_STATE_SIGNING_SECRET = 'z'.repeat(32);
  // Reset the cached secret between tests.
  vi.resetModules();
});

function reqStart(body: object): Request {
  return new Request('https://autopilot.dev/api/auth/sso/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function seedActiveSso(orgId: string, domain: string): void {
  stub.seed('organizations', [{ id: orgId, name: 'A' }]);
  stub.seed('organization_settings', [{
    organization_id: orgId,
    workos_organization_id: 'org_workos_111',
    workos_connection_id: 'conn_111',
    sso_connection_status: 'active',
  }]);
  stub.seed('organization_domain_claims', [{
    id: randomUUID(),
    organization_id: orgId,
    domain,
    status: 'verified',
    ever_verified: true,
    challenge_token: 'a'.repeat(64),
    verified_at: new Date().toISOString(),
  }]);
}

describe('POST /api/auth/sso/start', () => {
  it('happy path → returns authorize URL + sets sso_state cookie + inserts state row', async () => {
    const { POST: P } = await import('@/app/api/auth/sso/start/route');
    const orgId = randomUUID();
    seedActiveSso(orgId, 'acme.com');
    const r = await P(reqStart({ email: 'alice@acme.com' }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.authorizationUrl).toBe('https://api.workos.com/sso/authorize?stub=1');
    const setCookie = r.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/sso_state=[^;]+/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    const states = stub.tables.get('sso_authentication_states') ?? [];
    expect(states.length).toBe(1);
    expect(states[0]!.organization_id).toBe(orgId);
    expect(states[0]!.workos_organization_id).toBe('org_workos_111');
  });

  it('email domain not claimed → 404 sso_unavailable (anti-enumeration)', async () => {
    const { POST: P } = await import('@/app/api/auth/sso/start/route');
    const r = await P(reqStart({ email: 'alice@unknown-domain.example' }));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('sso_unavailable');
  });

  it('claimed but SSO inactive → 404 sso_unavailable (codex pass-2 WARNING #8)', async () => {
    const { POST: P } = await import('@/app/api/auth/sso/start/route');
    const orgId = randomUUID();
    seedActiveSso(orgId, 'acme.com');
    stub.tables.get('organization_settings')![0]!.sso_connection_status = 'disabled';
    const r = await P(reqStart({ email: 'alice@acme.com' }));
    expect(r.status).toBe(404);
  });

  it('malformed email → 404 sso_unavailable', async () => {
    const { POST: P } = await import('@/app/api/auth/sso/start/route');
    const r = await P(reqStart({ email: 'garbage' }));
    expect(r.status).toBe(404);
  });

  it('builds authorize URL with clientId + connection + state + redirectUri', async () => {
    const { POST: P } = await import('@/app/api/auth/sso/start/route');
    const orgId = randomUUID();
    seedActiveSso(orgId, 'acme.com');
    await P(reqStart({ email: 'alice@acme.com' }));
    expect(getAuthorizationUrlMock).toHaveBeenCalledWith(expect.objectContaining({
      connection: 'conn_111',
      clientId: 'client_test_stub',
      redirectUri: 'https://autopilot.dev/api/auth/sso/callback',
    }));
  });
});
