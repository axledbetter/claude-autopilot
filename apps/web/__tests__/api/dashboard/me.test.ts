import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stub } from '../../_helpers/supabase-stub';
import { createHash } from 'crypto';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));

let currentUser: { id: string; email?: string } | null = null;
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));

const { GET } = await import('@/app/api/dashboard/me/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
});

const KEY_A = `clp_${'a'.repeat(64)}`;

describe('GET /api/dashboard/me', () => {
  it('returns email + memberships + fingerprint for session-authed user', async () => {
    currentUser = { id: 'user1', email: 'alex@example.com' };
    stub.seed('memberships', [
      { user_id: 'user1', organization_id: 'org1', role: 'admin', status: 'active' },
    ]);
    stub.seed('organizations', [
      { id: 'org1', name: 'Acme' },
    ]);
    stub.seed('runs', [
      { user_id: 'user1', created_at: '2026-05-07T12:00:00Z', source_verified: true },
      { user_id: 'user1', created_at: '2026-05-06T12:00:00Z', source_verified: false },
    ]);

    const r = await GET(new Request('http://x'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.email).toBe('alex@example.com');
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0].name).toBe('Acme');
    expect(body.organizations[0].role).toBe('admin');
    expect(body.lastUploadAt).toBe('2026-05-07T12:00:00Z');
  });

  it('returns 401 when not authenticated', async () => {
    const r = await GET(new Request('http://x'));
    expect(r.status).toBe(401);
  });

  it('authenticates via API key bearer', async () => {
    const keyHash = createHash('sha256').update(KEY_A).digest('hex');
    stub.seed('api_keys', [{
      id: 'key1', user_id: 'user1', key_hash: keyHash,
      prefix_display: `clp_${'a'.repeat(12)}`, label: null,
      created_at: new Date().toISOString(), last_used_at: null, revoked_at: null,
    }]);
    stub.seed('users', [{ id: 'user1', email: 'alex@example.com' }]);

    const r = await GET(new Request('http://x', {
      headers: { authorization: `Bearer ${KEY_A}` },
    }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.email).toBe('alex@example.com');
    expect(body.fingerprint).toBe(`clp_${'a'.repeat(12)}`);
  });
});
