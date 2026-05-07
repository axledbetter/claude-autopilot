import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../_helpers/supabase-stub';

// Top-level mocks — registered before route module loads.
vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));
// Stub the SSR cookie path — tests use x-test-user instead.
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));

const { POST } = await import('@/app/api/upload-session/route');

beforeEach(() => {
  process.env.UPLOAD_SESSION_JWT_SECRET = '0'.repeat(64);
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  (process.env as Record<string, string>).NODE_ENV = 'test';
  stub.reset();
});

function makeReq(body: object, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/upload-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function seedRunOwnedBy(userId: string, orgId: string | null = null): string {
  const runId = '01HQK8' + 'A'.repeat(20);
  stub.seed('runs', [{ id: runId, user_id: userId, organization_id: orgId }]);
  return runId;
}

describe('POST /api/upload-session', () => {
  it('test 1: valid Supabase session + own runId → 201 with full claim set', async () => {
    const userId = randomUUID();
    const runId = seedRunOwnedBy(userId);
    const res = await POST(makeReq({ runId, expectedChunkCount: 3 }, { 'x-test-user': userId }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.uploadToken).toBeTypeOf('string');
    expect(body.session.runId).toBe(runId);
    expect(body.session.jti).toBeTypeOf('string');
  });

  it('test 2: API key auth → 201', async () => {
    const userId = randomUUID();
    const runId = seedRunOwnedBy(userId);
    stub.seed('api_keys', [{ id: 'ak1', user_id: userId, key_hash: 'hash-of-key1', revoked_at: null }]);
    const res = await POST(makeReq({ runId, expectedChunkCount: 1 }, { authorization: 'Bearer key1' }));
    expect(res.status).toBe(201);
  });

  it('test 3: no auth → 401', async () => {
    const res = await POST(makeReq({ runId: 'r1', expectedChunkCount: 1 }));
    expect(res.status).toBe(401);
  });

  it('test 4: runId belongs to another tenant → 403', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const runId = seedRunOwnedBy(owner);
    const res = await POST(makeReq({ runId, expectedChunkCount: 1 }, { 'x-test-user': other }));
    expect(res.status).toBe(403);
  });

  it('test 5: in-flight non-consumed session already exists → 409', async () => {
    const userId = randomUUID();
    const runId = seedRunOwnedBy(userId);
    stub.seed('upload_sessions', [{
      id: 'sess1', run_id: runId, user_id: userId, organization_id: null,
      jti: 'old', token_hash: 'h', expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null, next_expected_seq: 0,
      chain_tip_hash: '0'.repeat(64),
    }]);
    const res = await POST(makeReq({ runId, expectedChunkCount: 1 }, { 'x-test-user': userId }));
    expect(res.status).toBe(409);
  });

  it('test 6: concurrent session-mint same run → 1 succeeds, 1 fails', async () => {
    const userId = randomUUID();
    const runId = seedRunOwnedBy(userId);
    const [a, b] = await Promise.all([
      POST(makeReq({ runId, expectedChunkCount: 1 }, { 'x-test-user': userId })),
      POST(makeReq({ runId, expectedChunkCount: 1 }, { 'x-test-user': userId })),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([201, 409]);
  });
});
