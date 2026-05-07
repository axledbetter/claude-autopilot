import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stub } from '../../_helpers/supabase-stub';

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

const { POST } = await import('@/app/api/dashboard/api-keys/mint/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
});

const VALID_NONCE = 'a'.repeat(32);
const VALID_CB = 'http://127.0.0.1:56010/cli-callback';

function req(body: object): Request {
  return new Request('http://x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/dashboard/api-keys/mint', () => {
  it('mints with valid auth + nonce + callbackUrl', async () => {
    currentUser = { id: 'user1', email: 'a@b.com' };
    const r = await POST(req({ nonce: VALID_NONCE, callbackUrl: VALID_CB }));
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.apiKey).toMatch(/^clp_[0-9a-f]{64}$/);
    expect(body.fingerprint).toMatch(/^clp_[0-9a-f]{12}$/);
    expect(body.keyId).toBeTruthy();
  });

  it('returns 401 without session', async () => {
    const r = await POST(req({ nonce: VALID_NONCE, callbackUrl: VALID_CB }));
    expect(r.status).toBe(401);
  });

  it('returns 409 on nonce dedup within 5 min', async () => {
    currentUser = { id: 'user1' };
    const r1 = await POST(req({ nonce: VALID_NONCE, callbackUrl: VALID_CB }));
    expect(r1.status).toBe(201);
    const r2 = await POST(req({ nonce: VALID_NONCE, callbackUrl: VALID_CB }));
    expect(r2.status).toBe(409);
  });

  it('returns 422 for invalid callbackUrl', async () => {
    currentUser = { id: 'user1' };
    const r = await POST(req({ nonce: VALID_NONCE, callbackUrl: 'http://attacker.example/cli-callback' }));
    expect(r.status).toBe(422);
  });

  it('returns 422 for invalid nonce shape', async () => {
    currentUser = { id: 'user1' };
    const r = await POST(req({ nonce: 'too-short', callbackUrl: VALID_CB }));
    expect(r.status).toBe(422);
  });
});
