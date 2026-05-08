// Phase 4 — Spec test 29: malformed run_status sanitizes to null;
// rest of finalize succeeds (regression for codex pass 2 WARNING — DB
// CHECK shouldn't fail the whole UPDATE on a buggy CLI).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../_helpers/supabase-stub';
import { sanitizeFinalizeMetadata } from '@/lib/runs/sanitize-finalize-metadata';

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

describe('sanitizeFinalizeMetadata (unit)', () => {
  it('out-of-enum run_status → null', () => {
    expect(sanitizeFinalizeMetadata({ run_status: 'not-an-enum-value' }).run_status).toBeNull();
  });
  it('valid enum value preserved', () => {
    expect(sanitizeFinalizeMetadata({ run_status: 'partial' }).run_status).toBe('partial');
  });
  it('cost above $1M → null', () => {
    expect(sanitizeFinalizeMetadata({ cost_usd: 2_000_000 }).cost_usd).toBeNull();
  });
  it('negative cost → null', () => {
    expect(sanitizeFinalizeMetadata({ cost_usd: -1 }).cost_usd).toBeNull();
  });
  it('cost rounds to 4 dp', () => {
    expect(sanitizeFinalizeMetadata({ cost_usd: 1.234567 }).cost_usd).toBe(1.2346);
  });
  it('duration > 7d → null', () => {
    expect(sanitizeFinalizeMetadata({ duration_ms: 8 * 24 * 3600 * 1000 }).duration_ms).toBeNull();
  });
  it('null state → all null', () => {
    expect(sanitizeFinalizeMetadata(null)).toEqual({ cost_usd: null, duration_ms: null, run_status: null });
  });
  it('non-object state → all null', () => {
    expect(sanitizeFinalizeMetadata('string')).toEqual({ cost_usd: null, duration_ms: null, run_status: null });
  });
});

describe('finalize with malformed run_status (integration)', () => {
  it('test 29: state.run_status="not-an-enum-value" → run_status persists as null, finalize 200', async () => {
    const { hashChunk, zeroHash } = await import('@/lib/upload/chain');
    const { mintUploadToken } = await import('@/lib/upload/jwt');

    const userId = randomUUID();
    const runId = '01HQK8' + 'C'.repeat(20);
    const sessionId = randomUUID();
    const jti = randomUUID();
    const { token } = mintUploadToken({ userId, runId, orgId: null, jti });
    const c0 = Buffer.from('{"event":"run.complete"}\n');
    const h0 = hashChunk(zeroHash, c0);
    stub.seed('runs', [{ id: runId, user_id: userId, organization_id: null }]);
    stub.seed('upload_sessions', [{
      id: sessionId, run_id: runId, user_id: userId, organization_id: null,
      jti, token_hash: 'h', expires_at: new Date(Date.now() + 600_000).toISOString(),
      consumed_at: null, next_expected_seq: 1, chain_tip_hash: h0,
    }]);
    stub.seed('upload_session_chunks', [{
      session_id: sessionId, seq: 0, hash: h0, bytes: c0.length,
      storage_path: `user/${userId}/${runId}/events/0.ndjson`, status: 'persisted',
    }]);

    const stateJson = {
      runId,
      cost_usd: 0.99,
      duration_ms: 5000,
      run_status: 'not-an-enum-value',  // malformed
    };
    const r = await FINALIZE(
      new Request(`http://localhost/api/runs/${runId}/finalize`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chainRoot: h0, expectedChunkCount: 1, stateJson }),
      }),
      { params: { runId } },
    );
    expect(r.status).toBe(200);
    const row = stub.tables.get('runs')!.find((x) => x.id === runId)!;
    expect(row.run_status).toBeNull();   // malformed → null
    expect(row.cost_usd).toBe(0.99);     // valid → preserved
    expect(row.duration_ms).toBe(5000);  // valid → preserved
    expect(row.source_verified).toBe(true);  // rest of finalize succeeded
  });
});
