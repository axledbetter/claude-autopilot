import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stub } from '../../_helpers/supabase-stub';
import { createHash } from 'crypto';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));

let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));

const { POST } = await import('@/app/api/dashboard/api-keys/revoke/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function seedKey(id: string, userId: string, raw: string): void {
  const keyHash = createHash('sha256').update(raw).digest('hex');
  stub.seed('api_keys', [{
    id,
    user_id: userId,
    key_hash: keyHash,
    prefix_display: `clp_${raw.slice(4, 16)}`,
    label: null,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: null,
  }]);
}

const KEY_A = `clp_${'a'.repeat(64)}`;

function jsonReq(body: object, headers: Record<string, string> = {}): Request {
  return new Request('http://x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/dashboard/api-keys/revoke', () => {
  it('revokes own key by keyId via session auth', async () => {
    currentUser = { id: 'user1' };
    seedKey('keyA', 'user1', KEY_A);
    const r = await POST(jsonReq({ keyId: 'keyA' }));
    expect(r.status).toBe(200);
    const rows = stub.tables.get('api_keys') ?? [];
    expect(rows[0]?.revoked_at).toBeTruthy();
  });

  it('returns 403 when revoking another user key', async () => {
    currentUser = { id: 'user2' };
    seedKey('keyA', 'user1', KEY_A);
    const r = await POST(jsonReq({ keyId: 'keyA' }));
    expect(r.status).toBe(403);
  });

  it('is idempotent on already-revoked key', async () => {
    currentUser = { id: 'user1' };
    seedKey('keyA', 'user1', KEY_A);
    const r1 = await POST(jsonReq({ keyId: 'keyA' }));
    expect(r1.status).toBe(200);
    const r2 = await POST(jsonReq({ keyId: 'keyA' }));
    expect(r2.status).toBe(200);
  });

  it('test 28 (revoke): cookie path with mismatched Origin → 403', async () => {
    currentUser = { id: 'user1' };
    seedKey('keyA', 'user1', KEY_A);
    const r = await POST(jsonReq({ keyId: 'keyA' }, { origin: 'https://attacker.example' }));
    expect(r.status).toBe(403);
  });

  it('test 28 (revoke): API-key path bypasses Origin check', async () => {
    seedKey('keyA', 'user1', KEY_A);
    // No session — auth via Bearer key. Origin omitted, no 403.
    const r = await POST(new Request('http://x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY_A}` },
      body: JSON.stringify({ keyId: 'keyA' }),
    }));
    expect(r.status).toBe(200);
  });
});
