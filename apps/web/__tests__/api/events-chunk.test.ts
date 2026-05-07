import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { stub } from '../_helpers/supabase-stub';
import { hashChunk, zeroHash } from '@/lib/upload/chain';
import { mintUploadToken } from '@/lib/upload/jwt';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));

const { PUT } = await import('@/app/api/runs/[runId]/events/[seq]/route');

beforeEach(() => {
  process.env.UPLOAD_SESSION_JWT_SECRET = '0'.repeat(64);
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.NODE_ENV = 'test';
  stub.reset();
});

interface Seeded {
  runId: string;
  userId: string;
  jti: string;
  token: string;
  sessionId: string;
}

function seed(): Seeded {
  const userId = randomUUID();
  const runId = '01HQK8' + 'A'.repeat(20);
  const sessionId = randomUUID();
  const jti = randomUUID();
  const { token } = mintUploadToken({ userId, runId, orgId: null, jti });
  stub.seed('runs', [{ id: runId, user_id: userId, organization_id: null }]);
  stub.seed('upload_sessions', [{
    id: sessionId, run_id: runId, user_id: userId, organization_id: null,
    jti, token_hash: 'h', expires_at: new Date(Date.now() + 600_000).toISOString(),
    consumed_at: null, next_expected_seq: 0, chain_tip_hash: zeroHash,
  }]);
  return { runId, userId, jti, token, sessionId };
}

function req(token: string, runId: string, seq: number, prevHash: string, body: Buffer): Request {
  return new Request(`http://localhost/api/runs/${runId}/events/${seq}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-ndjson',
      'x-chunk-prev-hash': prevHash,
    },
    body,
  });
}

describe('PUT /api/runs/:runId/events/:seq', () => {
  it('test 7: seq=0 with zero prev_hash → 201, session advances', async () => {
    const { token, runId } = seed();
    const body = Buffer.from('{"event":"run.started"}\n');
    const res = await PUT(req(token, runId, 0, zeroHash, body), { params: { runId, seq: '0' } });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.seq).toBe(0);
    expect(j.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('test 8: seq=1 with correct prev_hash → 201', async () => {
    const { token, runId, sessionId } = seed();
    const firstHash = hashChunk(zeroHash, Buffer.from('a'));
    const sessions = stub.tables.get('upload_sessions')!;
    sessions[0].next_expected_seq = 1;
    sessions[0].chain_tip_hash = firstHash;
    stub.seed('upload_session_chunks', [{
      session_id: sessionId, seq: 0, hash: firstHash, bytes: 1,
      storage_path: 'x', status: 'persisted',
    }]);

    const body = Buffer.from('b');
    const res = await PUT(req(token, runId, 1, firstHash, body), { params: { runId, seq: '1' } });
    expect(res.status).toBe(201);
  });

  it('test 9: wrong prev_hash → 409, no state mutation', async () => {
    const { token, runId } = seed();
    const wrong = '1'.repeat(64);
    const sessions = stub.tables.get('upload_sessions')!;
    const before = sessions[0].next_expected_seq;
    const res = await PUT(req(token, runId, 0, wrong, Buffer.from('a')), { params: { runId, seq: '0' } });
    expect(res.status).toBe(409);
    expect(stub.tables.get('upload_sessions')![0].next_expected_seq).toBe(before);
  });

  it('test 10: seq=2 when next_expected_seq=1 → 422 (structural)', async () => {
    const { token, runId } = seed();
    const sessions = stub.tables.get('upload_sessions')!;
    sessions[0].next_expected_seq = 1;
    sessions[0].chain_tip_hash = '2'.repeat(64);
    const res = await PUT(req(token, runId, 2, '2'.repeat(64), Buffer.from('a')), { params: { runId, seq: '2' } });
    expect(res.status).toBe(422);
  });

  it('test 11: seq=0 replay → 409 on second', async () => {
    const { token, runId } = seed();
    const body = Buffer.from('a');
    const r1 = await PUT(req(token, runId, 0, zeroHash, body), { params: { runId, seq: '0' } });
    expect(r1.status).toBe(201);
    // After advance, replaying seq=0 with the same prev_hash hits wrong_seq
    // (P0006) since next_expected_seq is now 1. The duplicate-recovery
    // branch only fires if the chunk row still exists at (session_id, 0)
    // which it does — but with status='persisted' and identical payload,
    // the recovery returns success (idempotent same-payload retry).
    // To assert a true conflict, we replay with DIFFERENT payload.
    const r2 = await PUT(req(token, runId, 0, zeroHash, Buffer.from('b')), { params: { runId, seq: '0' } });
    expect(r2.status).toBe(409);
  });

  it('test 13: chunk body > 1 MiB → 413', async () => {
    const { token, runId } = seed();
    const oversize = Buffer.alloc(1024 * 1024 + 1);
    const res = await PUT(req(token, runId, 0, zeroHash, oversize), { params: { runId, seq: '0' } });
    expect(res.status).toBe(413);
  });
});

describe('PUT chunk — concurrency + token + recovery', () => {
  it('test 12: concurrent same seq with DIFFERENT bodies → exactly one 201, one 409 or 422', async () => {
    const { token, runId } = seed();
    const [a, b] = await Promise.all([
      PUT(req(token, runId, 0, zeroHash, Buffer.from('aaaa')), { params: { runId, seq: '0' } }),
      PUT(req(token, runId, 0, zeroHash, Buffer.from('bbbb')), { params: { runId, seq: '0' } }),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes[0]).toBe(201);
    expect([409, 422]).toContain(codes[1]);
  });

  it('test 14: JWT missing aud → 401', async () => {
    const { runId } = seed();
    const bad = jwt.sign(
      { sub: 'u', run_id: runId, org_id: '', jti: 'j', iss: 'autopilot.dev' },
      '0'.repeat(64),
      { algorithm: 'HS256', expiresIn: '15m' },
    );
    const res = await PUT(req(bad, runId, 0, zeroHash, Buffer.from('a')), { params: { runId, seq: '0' } });
    expect(res.status).toBe(401);
  });

  it('test 15: JWT for wrong runId (claim/path mismatch) → 403', async () => {
    const { runId } = seed();
    const otherRun = '01HQK9' + 'B'.repeat(20);
    const { token } = mintUploadToken({ userId: randomUUID(), runId: otherRun, orgId: null, jti: randomUUID() });
    const res = await PUT(req(token, runId, 0, zeroHash, Buffer.from('a')), { params: { runId, seq: '0' } });
    expect(res.status).toBe(403);
  });

  it('test 16: session consumed → 401', async () => {
    const { token, runId } = seed();
    const sessions = stub.tables.get('upload_sessions')!;
    sessions[0].consumed_at = new Date().toISOString();
    const res = await PUT(req(token, runId, 0, zeroHash, Buffer.from('a')), { params: { runId, seq: '0' } });
    expect(res.status).toBe(401);
  });

  it('test 17: token-expired vs session-expired distinguishable', async () => {
    const { runId } = seed();
    // Token expired (>60s past expiry to clear clock skew tolerance), session valid:
    const expiredToken = jwt.sign(
      { sub: 'u', run_id: runId, org_id: '', jti: 'j', aud: 'claude-autopilot-upload', iss: 'autopilot.dev' },
      '0'.repeat(64),
      { algorithm: 'HS256', expiresIn: -120 },
    );
    const r1 = await PUT(req(expiredToken, runId, 0, zeroHash, Buffer.from('a')), { params: { runId, seq: '0' } });
    expect(r1.status).toBe(401);
    const j1 = await r1.json();
    expect(j1.error).toMatch(/token expired/);

    // Token valid, session expired:
    const liveJti = randomUUID();
    const userId = randomUUID();
    const { token: validToken } = mintUploadToken({ userId, runId, orgId: null, jti: liveJti });
    const sessions = stub.tables.get('upload_sessions')!;
    sessions[0].jti = liveJti;
    sessions[0].user_id = userId;
    sessions[0].expires_at = new Date(Date.now() - 60_000).toISOString();
    const r2 = await PUT(req(validToken, runId, 0, zeroHash, Buffer.from('a')), { params: { runId, seq: '0' } });
    expect(r2.status).toBe(401);
    const j2 = await r2.json();
    expect(j2.error).toMatch(/session expired/);
  });

  it('test 18: crashed-handler retry — pending row + identical bytes → idempotent advance', async () => {
    const { token, runId, sessionId } = seed();
    const body = Buffer.from('a');
    const expectedHash = hashChunk(zeroHash, body);
    const userId = stub.tables.get('upload_sessions')![0].user_id as string;
    const path = `user/${userId}/${runId}/events/0.ndjson`;

    // Simulate prior crash: storage object exists, chunk row at status='pending', session NOT advanced.
    stub.storage.set(path, body);
    stub.seed('upload_session_chunks', [{
      session_id: sessionId, seq: 0, hash: expectedHash, bytes: body.length,
      storage_path: path, status: 'pending',
    }]);

    const res = await PUT(req(token, runId, 0, zeroHash, body), { params: { runId, seq: '0' } });
    expect(res.status).toBe(201);
    expect(stub.tables.get('upload_sessions')![0].next_expected_seq).toBe(1);
    expect(stub.tables.get('upload_session_chunks')!.find((r) => r.seq === 0)!.status).toBe('persisted');
  });
});
