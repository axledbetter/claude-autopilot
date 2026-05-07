import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../_helpers/supabase-stub';
import { hashChunk, zeroHash } from '@/lib/upload/chain';
import { sha256OfCanonical } from '@/lib/upload/canonical';
import { mintUploadToken } from '@/lib/upload/jwt';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));

const { POST: FINALIZE } = await import('@/app/api/runs/[runId]/finalize/route');

beforeEach(() => {
  process.env.UPLOAD_SESSION_JWT_SECRET = '0'.repeat(64);
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  (process.env as Record<string, string>).NODE_ENV = 'test';
  stub.reset();
});

interface SeededState {
  runId: string;
  userId: string;
  jti: string;
  token: string;
  sessionId: string;
  chainRoot: string;
  chunkCount: number;
}

function seedComplete(): SeededState {
  const userId = randomUUID();
  const runId = '01HQK8' + 'A'.repeat(20);
  const sessionId = randomUUID();
  const jti = randomUUID();
  const { token } = mintUploadToken({ userId, runId, orgId: null, jti });

  // Two chunks already uploaded, status='persisted'.
  const c0Body = Buffer.from('{"event":"run.started"}\n');
  const c1Body = Buffer.from('{"event":"run.complete"}\n');
  const h0 = hashChunk(zeroHash, c0Body);
  const h1 = hashChunk(h0, c1Body);

  stub.seed('runs', [{ id: runId, user_id: userId, organization_id: null }]);
  stub.seed('upload_sessions', [{
    id: sessionId, run_id: runId, user_id: userId, organization_id: null,
    jti, token_hash: 'h', expires_at: new Date(Date.now() + 600_000).toISOString(),
    consumed_at: null, next_expected_seq: 2, chain_tip_hash: h1,
  }]);
  stub.seed('upload_session_chunks', [
    { session_id: sessionId, seq: 0, hash: h0, bytes: c0Body.length, storage_path: `user/${userId}/${runId}/events/0.ndjson`, status: 'persisted' },
    { session_id: sessionId, seq: 1, hash: h1, bytes: c1Body.length, storage_path: `user/${userId}/${runId}/events/1.ndjson`, status: 'persisted' },
  ]);
  return { runId, userId, jti, token, sessionId, chainRoot: h1, chunkCount: 2 };
}

function fReq(token: string, runId: string, body: object): Request {
  return new Request(`http://localhost/api/runs/${runId}/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/runs/:runId/finalize', () => {
  it('test 19: correct chain root + chunk count → 200, source_verified=TRUE, audit event', async () => {
    const s = seedComplete();
    const stateJson = { runId: s.runId, complete: true };
    const res = await FINALIZE(
      fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: s.chunkCount, stateJson }),
      { params: { runId: s.runId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sourceVerified).toBe(true);
    const runRow = stub.tables.get('runs')!.find((r) => r.id === s.runId)!;
    expect(runRow.source_verified).toBe(true);
    expect(runRow.events_chain_root).toBe(s.chainRoot);
    expect(runRow.state_sha256).toBe(sha256OfCanonical(stateJson));
    const audit = stub.tables.get('audit_events') ?? [];
    expect(audit.find((a) => a.action === 'run.uploaded')).toBeDefined();
  });

  it('test 20: finalize twice with identical body → 200 both, no second audit event', async () => {
    const s = seedComplete();
    const stateJson = { runId: s.runId };
    const a = await FINALIZE(fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: s.chunkCount, stateJson }), { params: { runId: s.runId } });
    expect(a.status).toBe(200);
    const b = await FINALIZE(fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: s.chunkCount, stateJson }), { params: { runId: s.runId } });
    expect(b.status).toBe(200);
    const audits = (stub.tables.get('audit_events') ?? []).filter((ev) => ev.action === 'run.uploaded');
    expect(audits.length).toBe(1);
  });

  it('test 21: finalize twice with different stateJson → 409 on second, state unchanged', async () => {
    const s = seedComplete();
    const stateA = { runId: s.runId, v: 1 };
    const stateB = { runId: s.runId, v: 2 };
    await FINALIZE(fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: s.chunkCount, stateJson: stateA }), { params: { runId: s.runId } });
    const before = stub.tables.get('runs')!.find((r) => r.id === s.runId)!.state_sha256;
    const r = await FINALIZE(fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: s.chunkCount, stateJson: stateB }), { params: { runId: s.runId } });
    expect(r.status).toBe(409);
    expect(stub.tables.get('runs')!.find((row) => row.id === s.runId)!.state_sha256).toBe(before);
  });

  it('test 22: chainRoot mismatch → 409', async () => {
    const s = seedComplete();
    const r = await FINALIZE(fReq(s.token, s.runId, { chainRoot: '9'.repeat(64), expectedChunkCount: s.chunkCount, stateJson: {} }), { params: { runId: s.runId } });
    expect(r.status).toBe(409);
  });
});

describe('finalize — structural + concurrency', () => {
  it('test 23: expectedChunkCount mismatch → 422', async () => {
    const s = seedComplete();
    const r = await FINALIZE(fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: 5, stateJson: {} }), { params: { runId: s.runId } });
    expect(r.status).toBe(422);
  });

  it('test 24: finalize before any chunks uploaded → 422', async () => {
    const userId = randomUUID();
    const runId = '01HQKEMPTY' + 'A'.repeat(15);
    const sessionId = randomUUID();
    const jti = randomUUID();
    const { token } = mintUploadToken({ userId, runId, orgId: null, jti });
    stub.seed('runs', [{ id: runId, user_id: userId, organization_id: null }]);
    stub.seed('upload_sessions', [{
      id: sessionId, run_id: runId, user_id: userId, organization_id: null,
      jti, token_hash: 'h', expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null, next_expected_seq: 0, chain_tip_hash: zeroHash,
    }]);
    const r = await FINALIZE(fReq(token, runId, { chainRoot: zeroHash, expectedChunkCount: 0, stateJson: {} }), { params: { runId } });
    expect(r.status).toBe(422);
  });

  it('test 25: caller mistake on count (says 1, only 0 uploaded) → 422', async () => {
    const userId = randomUUID();
    const runId = '01HQK1' + 'A'.repeat(20);
    const sessionId = randomUUID();
    const jti = randomUUID();
    const { token } = mintUploadToken({ userId, runId, orgId: null, jti });
    stub.seed('runs', [{ id: runId, user_id: userId, organization_id: null }]);
    stub.seed('upload_sessions', [{
      id: sessionId, run_id: runId, user_id: userId, organization_id: null,
      jti, token_hash: 'h', expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null, next_expected_seq: 0, chain_tip_hash: zeroHash,
    }]);
    const r = await FINALIZE(fReq(token, runId, { chainRoot: zeroHash, expectedChunkCount: 1, stateJson: {} }), { params: { runId } });
    expect(r.status).toBe(422);
  });

  it('test 26: finalize-with-stale-chainRoot returns 409', async () => {
    // Use the correct chunk count so the count check passes — then the
    // stale chainRoot triggers the chain-root mismatch (409). This is the
    // race where finalize fires while another chunk PUT was about to
    // advance chain_tip_hash; the seed's count matches but the caller's
    // chainRoot is from before the (in-flight) advance.
    const s = seedComplete();
    const stale = '7'.repeat(64);
    const r = await FINALIZE(
      fReq(s.token, s.runId, { chainRoot: stale, expectedChunkCount: s.chunkCount, stateJson: {} }),
      { params: { runId: s.runId } },
    );
    expect(r.status).toBe(409);
  });

  it('test 27: terminal DB write failure surfaces 500 (bugbot HIGH)', async () => {
    const s = seedComplete();
    // Tell the stub to force-fail any UPDATE on the runs table.
    stub.forceUpdateError.add('runs');
    try {
      const stateJson = { runId: s.runId };
      const r = await FINALIZE(
        fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: s.chunkCount, stateJson }),
        { params: { runId: s.runId } },
      );
      expect(r.status).toBe(500);
      const body = await r.json();
      expect(body.error).toMatch(/failed to mark run verified/);
    } finally {
      stub.forceUpdateError.clear();
    }
  });
});
