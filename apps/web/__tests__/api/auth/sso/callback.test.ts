import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID, createHash } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));

// @supabase/supabase-js anon createClient — return the same stub. The stub's
// asClient already exposes the full auth.verifyOtp etc.
vi.mock('@supabase/supabase-js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, createClient: () => stub.asClient() };
});

const getProfileAndTokenMock = vi.fn();
class FakeWorkOS {
  sso = {
    getAuthorizationUrl: vi.fn(),
    getProfileAndToken: getProfileAndTokenMock,
  };
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
  process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF = 'stub';
});

interface SeedResult { orgId: string; stateId: string; nonce: string; userId: string; cookieValue: string }

function seedFlow({ withUser = true, withVerifiedDomain = true, withActiveSso = true } = {}): SeedResult {
  const orgId = randomUUID();
  const stateId = randomUUID();
  const nonce = 'n'.repeat(64);
  const nonceHash = createHash('sha256').update(nonce).digest('hex');
  stub.seed('organizations', [{ id: orgId, name: 'Acme' }]);
  stub.seed('organization_settings', [{
    organization_id: orgId,
    workos_organization_id: 'org_workos_111',
    workos_connection_id: 'conn_111',
    sso_connection_status: withActiveSso ? 'active' : 'disabled',
  }]);
  if (withVerifiedDomain) {
    stub.seed('organization_domain_claims', [{
      id: randomUUID(),
      organization_id: orgId,
      domain: 'acme.com',
      status: 'verified',
      ever_verified: true,
      challenge_token: 'a'.repeat(64),
      verified_at: new Date().toISOString(),
    }]);
  }
  stub.seed('sso_authentication_states', [{
    id: stateId,
    nonce: nonceHash,
    organization_id: orgId,
    workos_organization_id: 'org_workos_111',
    workos_connection_id: 'conn_111',
    initiated_email: 'alice@acme.com',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    consumed_at: null,
    created_at: new Date().toISOString(),
  }]);
  let userId = '';
  if (withUser) {
    userId = randomUUID();
    stub.seed('auth.users', [{ id: userId, email: 'alice@acme.com' }]);
  }
  const cookieValue = signStateCookie({ stateId, nonce }, getSsoStateSigningSecret());
  return { orgId, stateId, nonce, userId, cookieValue };
}

function reqCallback(stateId: string, code: string, cookieValue: string | null): Request {
  const req = new Request(
    `https://autopilot.dev/api/auth/sso/callback?state=${stateId}&code=${code}`,
    {
      method: 'GET',
      headers: cookieValue ? { cookie: `sso_state=${cookieValue}` } : {},
    },
  );
  // Patch Next.js req.cookies.get shape — Next.js wraps Request with an object exposing .cookies.get(name) → { name, value }.
  (req as unknown as { cookies: { get: (n: string) => { value?: string } | undefined } }).cookies = {
    get: (name: string) => name === 'sso_state' && cookieValue ? { value: cookieValue } : undefined,
  };
  return req;
}

function setProfile(profile = {
  id: 'workos_user_123',
  email: 'alice@acme.com',
  organizationId: 'org_workos_111',
  connectionId: 'conn_111',
  firstName: 'Alice',
  lastName: 'A',
}): void {
  getProfileAndTokenMock.mockResolvedValue({ profile });
}

describe('GET /api/auth/sso/callback', () => {
  it('happy path with linked user → 302 to /dashboard, sso_state cookie cleared', async () => {
    const { stateId, cookieValue } = seedFlow();
    setProfile();
    const r = await GET(reqCallback(stateId, 'workos_code_x', cookieValue));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://autopilot.dev/dashboard');
    const setCookie = r.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/sso_state=;[^,]*Max-Age=0/);
    expect(setCookie).toMatch(/sb-stub-auth-token=/);
  });

  it('test 17: missing state cookie → 401 invalid_state, cookie cleared', async () => {
    const { stateId } = seedFlow();
    setProfile();
    const r = await GET(reqCallback(stateId, 'workos_code_x', null));
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('invalid_state');
    expect(r.headers.get('set-cookie') ?? '').toMatch(/sso_state=;[^,]*Max-Age=0/);
  });

  it('test 16: tampered cookie signature → 401 invalid_state', async () => {
    const { stateId, cookieValue } = seedFlow();
    setProfile();
    const tampered = `${cookieValue.slice(0, -2)}xx`;
    const r = await GET(reqCallback(stateId, 'workos_code_x', tampered));
    expect(r.status).toBe(401);
  });

  it('test 27: callback workos_organization_id mismatch → 401 state_workos_org_mismatch', async () => {
    const { stateId, cookieValue } = seedFlow();
    setProfile({
      id: 'workos_user_123', email: 'alice@acme.com',
      organizationId: 'org_workos_DIFFERENT', connectionId: 'conn_111',
      firstName: '', lastName: '',
    });
    const r = await GET(reqCallback(stateId, 'workos_code_x', cookieValue));
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('state_workos_org_mismatch');
  });

  it('test 28: callback connection_id mismatch → 401 state_workos_connection_mismatch', async () => {
    const { stateId, cookieValue } = seedFlow();
    setProfile({
      id: 'workos_user_123', email: 'alice@acme.com',
      organizationId: 'org_workos_111', connectionId: 'conn_DIFFERENT',
      firstName: '', lastName: '',
    });
    const r = await GET(reqCallback(stateId, 'workos_code_x', cookieValue));
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('state_workos_connection_mismatch');
  });

  it('test 29: replay state → second use → 401 state_already_consumed', async () => {
    const { stateId, cookieValue } = seedFlow();
    setProfile();
    const r1 = await GET(reqCallback(stateId, 'workos_code_x', cookieValue));
    expect(r1.status).toBe(302);
    const r2 = await GET(reqCallback(stateId, 'workos_code_y', cookieValue));
    expect(r2.status).toBe(401);
    expect((await r2.json()).error).toBe('state_already_consumed');
  });

  it('test 32: email domain not in any verified claim for resolved org → 403 email_domain_not_claimed_for_org', async () => {
    const { stateId, cookieValue } = seedFlow({ withVerifiedDomain: false });
    setProfile();
    const r = await GET(reqCallback(stateId, 'workos_code_x', cookieValue));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('email_domain_not_claimed_for_org');
  });

  it('test 19: first-time user → auto-creates auth.users + identity link + membership, mints session', async () => {
    const { stateId, cookieValue } = seedFlow({ withUser: false });
    setProfile();
    const r = await GET(reqCallback(stateId, 'workos_code_x', cookieValue));
    expect(r.status).toBe(302);
    const users = stub.tables.get('auth.users') ?? [];
    expect(users.length).toBe(1);
    expect(users[0]!.email).toBe('alice@acme.com');
    const identities = stub.tables.get('workos_user_identities') ?? [];
    expect(identities.length).toBe(1);
    expect(identities[0]!.workos_user_id).toBe('workos_user_123');
    const memberships = stub.tables.get('memberships') ?? [];
    expect(memberships.find((m) => m.user_id === users[0]!.id)).toBeTruthy();
  });

  it('audit appended for org.sso.user.signed_in on success', async () => {
    const { stateId, cookieValue } = seedFlow();
    setProfile();
    await GET(reqCallback(stateId, 'workos_code_x', cookieValue));
    const audits = stub.tables.get('audit_events') ?? [];
    expect(audits.find((a) => a.action === 'org.sso.user.signed_in')).toBeTruthy();
  });

  it('codex plan-pass CRITICAL #2 — verifyOtp returns {data:{user,session}} shape; route reads data.session.access_token', async () => {
    // The stub already returns the correct shape; this asserts the route doesn't crash on the destructure.
    const { stateId, cookieValue } = seedFlow();
    setProfile();
    const r = await GET(reqCallback(stateId, 'workos_code_x', cookieValue));
    expect(r.status).toBe(302);
  });
});
