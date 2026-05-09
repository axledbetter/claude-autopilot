// Phase 5.7 — record_workos_sign_in disabled/inactive/pending refusals
// + SSO callback redirect handling.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID, createHash } from 'crypto';
import { stub } from '../../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));

vi.mock('@supabase/supabase-js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, createClient: () => stub.asClient() };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: { setAll: (c: { name: string; value: string; options?: Record<string, unknown> }[]) => void } }) => ({
    auth: {
      setSession: async (s: { access_token: string; refresh_token: string }) => {
        opts.cookies.setAll([{
          name: 'sb-stub-auth-token',
          value: JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token }),
          options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 3600 },
        }]);
        return { error: null };
      },
    },
  }),
}));

const getProfileAndTokenMock = vi.fn();
class FakeWorkOS {
  sso = { getAuthorizationUrl: vi.fn(), getProfileAndToken: getProfileAndTokenMock };
  webhooks = { constructEvent: vi.fn() };
  organizations = {};
  adminPortal = {};
}
vi.mock('@workos-inc/node', () => ({ WorkOS: FakeWorkOS }));

const { GET } = await import('@/app/api/auth/sso/callback/route');
const { signStateCookie, getSsoStateSigningSecret } = await import('@/lib/workos/sign-in');

beforeEach(() => {
  stub.reset();
  getProfileAndTokenMock.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.WORKOS_API_KEY = 'sk_test_stub';
  process.env.WORKOS_CLIENT_ID = 'client_test_stub';
  process.env.SSO_STATE_SIGNING_SECRET = 'z'.repeat(32);
});

interface SeedResult { orgId: string; stateId: string; nonce: string; userId: string; cookieValue: string }

function seedFlow(memberStatus: 'active' | 'disabled' | 'inactive' | 'pending' | null = 'active'): SeedResult {
  const orgId = randomUUID();
  const stateId = randomUUID();
  const nonce = 'n'.repeat(64);
  const nonceHash = createHash('sha256').update(nonce).digest('hex');
  stub.seed('organizations', [{ id: orgId, name: 'Acme' }]);
  stub.seed('organization_settings', [{
    organization_id: orgId,
    workos_organization_id: 'org_workos_111',
    workos_connection_id: 'conn_111',
    sso_connection_status: 'active',
  }]);
  stub.seed('organization_domain_claims', [{
    id: randomUUID(), organization_id: orgId, domain: 'acme.com',
    status: 'verified', ever_verified: true,
    challenge_token: 'a'.repeat(64), verified_at: new Date().toISOString(),
  }]);
  stub.seed('sso_authentication_states', [{
    id: stateId, nonce: nonceHash, organization_id: orgId,
    workos_organization_id: 'org_workos_111', workos_connection_id: 'conn_111',
    initiated_email: 'alice@acme.com',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    consumed_at: null, created_at: new Date().toISOString(),
  }]);
  const userId = randomUUID();
  stub.seed('auth.users', [{ id: userId, email: 'alice@acme.com' }]);
  if (memberStatus !== null) {
    stub.seed('memberships', [{
      id: randomUUID(), organization_id: orgId, user_id: userId,
      role: 'member', status: memberStatus, joined_at: new Date().toISOString(),
    }]);
  }
  const cookieValue = signStateCookie({ stateId, nonce }, getSsoStateSigningSecret());
  return { orgId, stateId, nonce, userId, cookieValue };
}

function reqCallback(stateId: string, code: string, cookieValue: string): Request {
  const req = new Request(
    `https://autopilot.dev/api/auth/sso/callback?state=${stateId}&code=${code}`,
    { method: 'GET', headers: { cookie: `sso_state=${cookieValue}` } },
  );
  (req as unknown as { cookies: { get: (n: string) => { value?: string } | undefined; getAll: () => { name: string; value: string }[] } }).cookies = {
    get: (name: string) => name === 'sso_state' ? { value: cookieValue } : undefined,
    getAll: () => [{ name: 'sso_state', value: cookieValue }],
  };
  return req;
}

function setProfile(): void {
  getProfileAndTokenMock.mockResolvedValue({
    profile: {
      id: 'workos_user_alice',
      email: 'alice@acme.com',
      organizationId: 'org_workos_111',
      connectionId: 'conn_111',
      firstName: 'Alice',
      lastName: 'A',
    },
  });
}

describe('Phase 5.7 — SSO callback handles disabled/inactive/pending', () => {
  it('disabled member → 302 to /login/sso?reason=member_disabled, sso_state cookie cleared', async () => {
    const { stateId, cookieValue } = seedFlow('disabled');
    setProfile();
    const r = await GET(reqCallback(stateId, 'wos_code_x', cookieValue));
    expect(r.status).toBe(302);
    const loc = r.headers.get('location') ?? '';
    expect(loc).toContain('/login/sso');
    expect(loc).toContain('reason=member_disabled');
    expect(loc).toContain('alice%40acme.com');
    const setCookie = r.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/sso_state=;[^,]*Max-Age=0/);
  });

  it('inactive member → 302 reason=member_inactive', async () => {
    const { stateId, cookieValue } = seedFlow('inactive');
    setProfile();
    const r = await GET(reqCallback(stateId, 'wos_code_x', cookieValue));
    expect(r.status).toBe(302);
    expect(r.headers.get('location') ?? '').toContain('reason=member_inactive');
  });

  it('pending member → 302 reason=invite_pending', async () => {
    const { stateId, cookieValue } = seedFlow('pending');
    setProfile();
    const r = await GET(reqCallback(stateId, 'wos_code_x', cookieValue));
    expect(r.status).toBe(302);
    expect(r.headers.get('location') ?? '').toContain('reason=invite_pending');
  });

  it('active member → still 302 to /dashboard (regression)', async () => {
    const { stateId, cookieValue } = seedFlow('active');
    setProfile();
    const r = await GET(reqCallback(stateId, 'wos_code_x', cookieValue));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://autopilot.dev/dashboard');
  });
});
