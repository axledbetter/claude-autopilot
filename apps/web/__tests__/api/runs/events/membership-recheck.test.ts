// apps/web/__tests__/api/runs/events/membership-recheck.test.ts
//
// v7.1 spec test #2 — per-request membership re-check on event-write.
//
// Coverage:
//   (a) v7.1 token + active member → 201
//   (b) v7.1 token + disabled member → 403 member_disabled, NO chunk
//       written (assert claim_chunk_slot NEVER called), NO Storage upload
//       (assert storage.upload NEVER called)
//   (c) v7.1 token + inactive → 403 member_inactive
//   (d) v7.1 token + no membership row → 403 no_membership
//   (e) personal run JWT (org_id='') → 201 (no membership RPC call)
//   (f) RPC error → 503 member_check_failed (codex pass-1 WARNING #2 —
//       retryable status)
//   (g) v7.0-shape org-scoped token (no mint_status, org_id present) →
//       membership RPC IS called (codex pass-1 CRITICAL #2 — org_id is
//       sole authority)
//   (h) ordering: assertActiveMembership called BEFORE claim_chunk_slot
//       via call-order spy

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
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

const { PUT } = await import('@/app/api/runs/[runId]/events/[seq]/route');

const SECRET = '0'.repeat(64);

beforeEach(() => {
  process.env.UPLOAD_SESSION_JWT_SECRET = SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  (process.env as Record<string, string>).NODE_ENV = 'test';
  stub.reset();
});

interface SeededOrg {
  runId: string;
  userId: string;
  orgId: string;
  jti: string;
  sessionId: string;
  token: string;
}

function seedOrgScoped(membershipStatus: string | 'no_row'): SeededOrg {
  const userId = randomUUID();
  const orgId = randomUUID();
  const runId = '01HQK8' + 'O'.repeat(20);
  const sessionId = randomUUID();
  const jti = randomUUID();
  const { token } = mintUploadToken({ userId, runId, orgId, jti, mintStatus: 'active' });
  stub.seed('runs', [{ id: runId, user_id: userId, organization_id: orgId }]);
  stub.seed('upload_sessions', [{
    id: sessionId, run_id: runId, user_id: userId, organization_id: orgId,
    jti, token_hash: 'h', expires_at: new Date(Date.now() + 600_000).toISOString(),
    consumed_at: null, next_expected_seq: 0, chain_tip_hash: zeroHash,
  }]);
  if (membershipStatus !== 'no_row') {
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: userId, status: membershipStatus, role: 'member' },
    ]);
  }
  return { runId, userId, orgId, jti, sessionId, token };
}

function chunkReq(token: string, runId: string, seq: number, prevHash: string, body: Buffer): Request {
  return new Request(`http://localhost/api/runs/${runId}/events/${seq}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-ndjson',
      'x-chunk-prev-hash': prevHash,
    },
    body: new Uint8Array(body),
  });
}

describe('PUT /api/runs/:runId/events/:seq — v7.1 membership re-check', () => {
  it('(a) active member → 201', async () => {
    const s = seedOrgScoped('active');
    const res = await PUT(chunkReq(s.token, s.runId, 0, zeroHash, Buffer.from('a')), { params: { runId: s.runId, seq: '0' } });
    expect(res.status).toBe(201);
  });

  it('(b) disabled member → 403 member_disabled + NO claim_chunk_slot + NO storage.upload', async () => {
    const s = seedOrgScoped('disabled');
    const callRpcSpy = vi.spyOn(stub, 'callRpc');

    // Spy on the storage.upload path. The stub `asClient()` builds storage
    // dynamically — we wrap stub.storage.set as the proxy for "upload".
    const storageWritesBefore = stub.storage.size;

    const res = await PUT(chunkReq(s.token, s.runId, 0, zeroHash, Buffer.from('a')), { params: { runId: s.runId, seq: '0' } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('member_disabled');

    // Call-order assertion: claim_chunk_slot MUST NOT have been invoked.
    const claimCalls = callRpcSpy.mock.calls.filter(([fn]) => fn === 'claim_chunk_slot');
    expect(claimCalls.length).toBe(0);

    // Storage MUST be untouched.
    expect(stub.storage.size).toBe(storageWritesBefore);

    callRpcSpy.mockRestore();
  });

  it('(c) inactive member → 403 member_inactive', async () => {
    const s = seedOrgScoped('inactive');
    const res = await PUT(chunkReq(s.token, s.runId, 0, zeroHash, Buffer.from('a')), { params: { runId: s.runId, seq: '0' } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('member_inactive');
  });

  it('(d) no membership row → 403 no_membership', async () => {
    const s = seedOrgScoped('no_row');
    const res = await PUT(chunkReq(s.token, s.runId, 0, zeroHash, Buffer.from('a')), { params: { runId: s.runId, seq: '0' } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('no_membership');
  });

  it('(e) personal run JWT (org_id="") → 201 (no membership RPC call)', async () => {
    const userId = randomUUID();
    const runId = '01HQK8' + 'P'.repeat(20);
    const sessionId = randomUUID();
    const jti = randomUUID();
    const { token } = mintUploadToken({ userId, runId, orgId: null, jti, mintStatus: 'personal' });
    stub.seed('runs', [{ id: runId, user_id: userId, organization_id: null }]);
    stub.seed('upload_sessions', [{
      id: sessionId, run_id: runId, user_id: userId, organization_id: null,
      jti, token_hash: 'h', expires_at: new Date(Date.now() + 600_000).toISOString(),
      consumed_at: null, next_expected_seq: 0, chain_tip_hash: zeroHash,
    }]);
    const callRpcSpy = vi.spyOn(stub, 'callRpc');
    const res = await PUT(chunkReq(token, runId, 0, zeroHash, Buffer.from('a')), { params: { runId, seq: '0' } });
    expect(res.status).toBe(201);
    const memberRpcCalls = callRpcSpy.mock.calls.filter(([fn]) => fn === 'check_membership_status');
    expect(memberRpcCalls.length).toBe(0);
    callRpcSpy.mockRestore();
  });

  it('(f) RPC error during membership check → 503 member_check_failed', async () => {
    const s = seedOrgScoped('active');
    const original = stub.callRpc.bind(stub);
    const callRpcSpy = vi.spyOn(stub, 'callRpc').mockImplementation(async (fn, args) => {
      if (fn === 'check_membership_status') {
        return { data: null, error: { code: 'P0001', message: 'simulated outage' } };
      }
      return original(fn, args);
    });
    const res = await PUT(chunkReq(s.token, s.runId, 0, zeroHash, Buffer.from('a')), { params: { runId: s.runId, seq: '0' } });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('member_check_failed');
    callRpcSpy.mockRestore();
  });

  it('(g) v7.0-shape org-scoped token (no mint_status) still triggers membership RPC', async () => {
    // Hand-craft a v7.0 token: no mint_status claim, org_id present. The
    // helper MUST still call check_membership_status because claims.org_id
    // is the SOLE authorization authority (codex pass-1 CRITICAL #2).
    const userId = randomUUID();
    const orgId = randomUUID();
    const runId = '01HQK8' + 'V'.repeat(20);
    const sessionId = randomUUID();
    const jti = randomUUID();
    const v70Token = jwt.sign(
      {
        sub: userId, run_id: runId, org_id: orgId, jti,
        aud: 'claude-autopilot-upload', iss: 'autopilot.dev',
      },
      SECRET,
      { algorithm: 'HS256', expiresIn: '15m' },
    );
    stub.seed('runs', [{ id: runId, user_id: userId, organization_id: orgId }]);
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: userId, status: 'disabled', role: 'member' },
    ]);
    stub.seed('upload_sessions', [{
      id: sessionId, run_id: runId, user_id: userId, organization_id: orgId,
      jti, token_hash: 'h', expires_at: new Date(Date.now() + 600_000).toISOString(),
      consumed_at: null, next_expected_seq: 0, chain_tip_hash: zeroHash,
    }]);
    const callRpcSpy = vi.spyOn(stub, 'callRpc');
    const res = await PUT(chunkReq(v70Token, runId, 0, zeroHash, Buffer.from('a')), { params: { runId, seq: '0' } });
    // Disabled membership → 403 member_disabled. The fact that we got
    // anything other than 201 proves the RPC fired.
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('member_disabled');
    const memberRpcCalls = callRpcSpy.mock.calls.filter(([fn]) => fn === 'check_membership_status');
    expect(memberRpcCalls.length).toBeGreaterThanOrEqual(1);
    callRpcSpy.mockRestore();
  });

  it('(h) ordering: assertActiveMembership runs BEFORE claim_chunk_slot', async () => {
    const s = seedOrgScoped('active');
    const callOrder: string[] = [];
    const original = stub.callRpc.bind(stub);
    const callRpcSpy = vi.spyOn(stub, 'callRpc').mockImplementation(async (fn, args) => {
      callOrder.push(fn);
      return original(fn, args);
    });
    const body = Buffer.from('a');
    const res = await PUT(chunkReq(s.token, s.runId, 0, zeroHash, body), { params: { runId: s.runId, seq: '0' } });
    expect(res.status).toBe(201);
    const membershipIdx = callOrder.indexOf('check_membership_status');
    const claimIdx = callOrder.indexOf('claim_chunk_slot');
    expect(membershipIdx).toBeGreaterThanOrEqual(0);
    expect(claimIdx).toBeGreaterThan(membershipIdx);
    callRpcSpy.mockRestore();
  });
});

// Suppress unused import lint — hashChunk is exported for consistency with
// the events-chunk.test.ts patterns; not used here directly.
void hashChunk;
