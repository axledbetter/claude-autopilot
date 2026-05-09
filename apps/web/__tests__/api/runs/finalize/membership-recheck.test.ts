// apps/web/__tests__/api/runs/finalize/membership-recheck.test.ts
//
// v7.1 spec test #3 — per-request membership re-check on finalize.
//
// Coverage:
//   (a) active member → 200 + sourceVerified=true
//   (b) disabled member → 403 member_disabled, NO finalize side-effects:
//       no manifest write (storage), no audit_events insert, no
//       consumed_at mutation (call-order spy)
//   (c) personal run → 200
//   (d) RPC error → 503 member_check_failed, NO side-effects

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';
import { hashChunk, zeroHash } from '@/lib/upload/chain';
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

interface SeededFinalize {
  runId: string;
  userId: string;
  orgId: string | null;
  jti: string;
  sessionId: string;
  token: string;
  chainRoot: string;
  chunkCount: number;
}

function seedReadyToFinalize(opts: { orgId: string | null; membershipStatus?: string | 'no_row' }): SeededFinalize {
  const userId = randomUUID();
  const runId = '01HQK8' + 'F'.repeat(20);
  const sessionId = randomUUID();
  const jti = randomUUID();
  const orgId = opts.orgId;
  const { token } = mintUploadToken({
    userId, runId, orgId, jti,
    mintStatus: orgId ? 'active' : 'personal',
  });
  const c0Body = Buffer.from('{"event":"run.complete"}\n');
  const h0 = hashChunk(zeroHash, c0Body);
  stub.seed('runs', [{ id: runId, user_id: userId, organization_id: orgId }]);
  stub.seed('upload_sessions', [{
    id: sessionId, run_id: runId, user_id: userId, organization_id: orgId,
    jti, token_hash: 'h', expires_at: new Date(Date.now() + 600_000).toISOString(),
    consumed_at: null, next_expected_seq: 1, chain_tip_hash: h0,
  }]);
  stub.seed('upload_session_chunks', [
    { session_id: sessionId, seq: 0, hash: h0, bytes: c0Body.length, storage_path: `user/${userId}/${runId}/events/0.ndjson`, status: 'persisted' },
  ]);
  if (orgId && opts.membershipStatus && opts.membershipStatus !== 'no_row') {
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: userId, status: opts.membershipStatus, role: 'owner' },
    ]);
  }
  return { runId, userId, orgId, jti, sessionId, token, chainRoot: h0, chunkCount: 1 };
}

function fReq(token: string, runId: string, body: object): Request {
  return new Request(`http://localhost/api/runs/${runId}/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/runs/:runId/finalize — v7.1 membership re-check', () => {
  it('(a) active member → 200 + sourceVerified=true', async () => {
    const s = seedReadyToFinalize({ orgId: randomUUID(), membershipStatus: 'active' });
    const res = await FINALIZE(
      fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: s.chunkCount, stateJson: { runId: s.runId } }),
      { params: { runId: s.runId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sourceVerified).toBe(true);
  });

  it('(b) disabled member → 403 member_disabled, NO side-effects (manifest/audit/consumed_at)', async () => {
    const s = seedReadyToFinalize({ orgId: randomUUID(), membershipStatus: 'disabled' });
    const callRpcSpy = vi.spyOn(stub, 'callRpc');
    const storageWritesBefore = stub.storage.size;
    const auditsBefore = (stub.tables.get('audit_events') ?? []).length;
    const sessionBefore = (stub.tables.get('upload_sessions') ?? [])[0];
    const consumedAtBefore = sessionBefore?.consumed_at ?? null;

    const res = await FINALIZE(
      fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: s.chunkCount, stateJson: { runId: s.runId } }),
      { params: { runId: s.runId } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('member_disabled');

    // Side-effect assertions:
    expect(stub.storage.size).toBe(storageWritesBefore);
    expect((stub.tables.get('audit_events') ?? []).length).toBe(auditsBefore);
    const sessionAfter = (stub.tables.get('upload_sessions') ?? [])[0];
    expect(sessionAfter?.consumed_at ?? null).toBe(consumedAtBefore);

    // Defensive: claim_chunk_slot / mark_chunk_persisted MUST NOT have
    // been triggered by finalize either.
    const claimCalls = callRpcSpy.mock.calls.filter(
      ([fn]) => fn === 'claim_chunk_slot' || fn === 'mark_chunk_persisted',
    );
    expect(claimCalls.length).toBe(0);

    callRpcSpy.mockRestore();
  });

  it('(c) personal run → 200', async () => {
    const s = seedReadyToFinalize({ orgId: null });
    const res = await FINALIZE(
      fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: s.chunkCount, stateJson: { runId: s.runId } }),
      { params: { runId: s.runId } },
    );
    expect(res.status).toBe(200);
  });

  it('(d) RPC error → 503 member_check_failed, NO side-effects', async () => {
    const s = seedReadyToFinalize({ orgId: randomUUID(), membershipStatus: 'active' });
    const original = stub.callRpc.bind(stub);
    const callRpcSpy = vi.spyOn(stub, 'callRpc').mockImplementation(async (fn, args) => {
      if (fn === 'check_membership_status') {
        return { data: null, error: { code: 'P0001', message: 'simulated outage' } };
      }
      return original(fn, args);
    });
    const storageWritesBefore = stub.storage.size;
    const auditsBefore = (stub.tables.get('audit_events') ?? []).length;
    const sessionBefore = (stub.tables.get('upload_sessions') ?? [])[0];
    const consumedAtBefore = sessionBefore?.consumed_at ?? null;

    const res = await FINALIZE(
      fReq(s.token, s.runId, { chainRoot: s.chainRoot, expectedChunkCount: s.chunkCount, stateJson: { runId: s.runId } }),
      { params: { runId: s.runId } },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('member_check_failed');

    expect(stub.storage.size).toBe(storageWritesBefore);
    expect((stub.tables.get('audit_events') ?? []).length).toBe(auditsBefore);
    const sessionAfter = (stub.tables.get('upload_sessions') ?? [])[0];
    expect(sessionAfter?.consumed_at ?? null).toBe(consumedAtBefore);

    callRpcSpy.mockRestore();
  });
});
