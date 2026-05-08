import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
const setCalls: { name: string; value: string; opts?: Record<string, unknown> }[] = [];
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [],
    get: () => undefined,
    set: (name: string, value: string, opts?: Record<string, unknown>) => {
      setCalls.push({ name, value, opts });
    },
  }),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const { POST } = await import('@/app/api/dashboard/active-org/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  setCalls.length = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function req(body: object, headers: Record<string, string> = {}): Request {
  return new Request('http://x/api/dashboard/active-org', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/dashboard/active-org', () => {
  it('test 1: active member sets cookie → 200', async () => {
    const orgId = randomUUID();
    const me = randomUUID();
    currentUser = { id: me };
    stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: me, role: 'member', status: 'active', joined_at: new Date().toISOString() }]);
    const r = await POST(req({ orgId }));
    expect(r.status).toBe(200);
    expect(setCalls.length).toBe(1);
    expect(setCalls[0]!.name).toBe('cao_active_org');
    expect(setCalls[0]!.value).toBe(orgId);
    expect(setCalls[0]!.opts).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
  });

  it('test 2: non-member → 404', async () => {
    const orgId = randomUUID();
    currentUser = { id: randomUUID() };
    stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: randomUUID(), role: 'owner', status: 'active', joined_at: new Date().toISOString() }]);
    const r = await POST(req({ orgId }));
    expect(r.status).toBe(404);
    expect(setCalls.length).toBe(0);
  });

  it('test 3: orgId null → clears cookie', async () => {
    currentUser = { id: randomUUID() };
    const r = await POST(req({ orgId: null }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.cleared).toBe(true);
    expect(setCalls[0]!.opts).toMatchObject({ maxAge: 0 });
  });

  it('test 4: no session → 401', async () => {
    const r = await POST(req({ orgId: randomUUID() }));
    expect(r.status).toBe(401);
  });

  it('test 5: malformed UUID → 422', async () => {
    currentUser = { id: randomUUID() };
    const r = await POST(req({ orgId: 'not-a-uuid' }));
    expect(r.status).toBe(422);
  });

  it('test 6: bad origin → 403', async () => {
    currentUser = { id: randomUUID() };
    const r = await POST(req({ orgId: randomUUID() }, { origin: 'https://attacker.example' }));
    expect(r.status).toBe(403);
  });
});
