// apps/web/__tests__/api/upload-session/identity-invariant.test.ts
//
// v7.1 spec test #7 (codex pass-1 WARNING #1) — JWT `sub` claim equals
// `r.user_id` whether mint was via cookie auth OR API key.
//
// Mint API key as user X for run owned by user X → JWT.sub = X.
// Mint API key as user X attempting run owned by user Y → still rejected
// per Phase 5.8 (sanity check that the helper does not weaken ownership).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { stub } from '../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));

const { POST } = await import('@/app/api/upload-session/route');
const { _resetBillingConfigForTests } = await import('@/lib/billing/plan-map');

const SECRET = '0'.repeat(64);

beforeEach(() => {
  process.env.UPLOAD_SESSION_JWT_SECRET = SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
  (process.env as Record<string, string>).NODE_ENV = 'test';
  stub.reset();
  _resetBillingConfigForTests();
});

function makeReq(body: object, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/upload-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('mint identity invariant — JWT.sub === run.user_id (v7.1)', () => {
  it('cookie auth: JWT.sub equals the run owner', async () => {
    const userId = randomUUID();
    const runId = '01HQK8' + 'A'.repeat(20);
    stub.seed('runs', [{ id: runId, user_id: userId, organization_id: null }]);
    const res = await POST(makeReq({ runId, expectedChunkCount: 1 }, { 'x-test-user': userId }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const decoded = jwt.verify(body.uploadToken, SECRET) as Record<string, unknown>;
    expect(decoded.sub).toBe(userId);
  });

  it('API-key auth: JWT.sub equals the run owner (NOT the API-key holder if those ever differ)', async () => {
    // Phase 5.8 invariant: api_keys.user_id IS the run owner. The mint
    // sets JWT.sub = r.user_id, which == api_keys.user_id == auth.userId
    // by construction.
    const ownerId = randomUUID();
    const runId = '01HQK8' + 'K'.repeat(20);
    stub.seed('runs', [{ id: runId, user_id: ownerId, organization_id: null }]);
    stub.seed('api_keys', [{ id: 'ak1', user_id: ownerId, key_hash: 'hash-of-key1', revoked_at: null }]);
    const res = await POST(makeReq({ runId, expectedChunkCount: 1 }, { authorization: 'Bearer key1' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const decoded = jwt.verify(body.uploadToken, SECRET) as Record<string, unknown>;
    expect(decoded.sub).toBe(ownerId);
  });

  it('API-key auth as user X for run owned by user Y → still rejected (sanity)', async () => {
    const owner = randomUUID();
    const otherUser = randomUUID();
    const runId = '01HQK8' + 'X'.repeat(20);
    stub.seed('runs', [{ id: runId, user_id: owner, organization_id: null }]);
    stub.seed('api_keys', [{ id: 'akX', user_id: otherUser, key_hash: 'hash-of-keyX', revoked_at: null }]);
    const res = await POST(makeReq({ runId, expectedChunkCount: 1 }, { authorization: 'Bearer keyX' }));
    // Personal run owned by `owner`; API key belongs to `otherUser`.
    // Ownership check fails → 403.
    expect(res.status).toBe(403);
  });
});
