// apps/web/__tests__/integration/disabled-mid-session.test.ts
//
// v7.1 spec test #6 — end-to-end: mid-session revocation collapses to
// ≤1 RPC (NOT ≤15min token TTL).
//
// (a) Mint upload-session as active member.
// (b) Admin disables member via Phase 5.7 disable_member RPC.
// (c) Attempted event-write with the still-valid JWT → 403 member_disabled
//     within 1 RPC call (≤1.5s, NOT ≤15min token TTL).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../_helpers/supabase-stub';
import { zeroHash } from '@/lib/upload/chain';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));

const { POST: MINT } = await import('@/app/api/upload-session/route');
const { PUT: EVENT_WRITE } = await import('@/app/api/runs/[runId]/events/[seq]/route');
const { _resetBillingConfigForTests } = await import('@/lib/billing/plan-map');

beforeEach(() => {
  process.env.UPLOAD_SESSION_JWT_SECRET = '0'.repeat(64);
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
  (process.env as Record<string, string>).NODE_ENV = 'test';
  stub.reset();
  _resetBillingConfigForTests();
});

describe('disabled-mid-session integration (v7.1)', () => {
  it('mint as active → disable via disable_member → next event-write returns 403 member_disabled', async () => {
    const userId = randomUUID();
    const ownerId = randomUUID();   // separate admin to avoid cannot_disable_self
    const orgId = randomUUID();
    const runId = '01HQK8' + 'I'.repeat(20);
    stub.seed('runs', [{ id: runId, user_id: userId, organization_id: orgId }]);
    stub.seed('entitlements', [{
      organization_id: orgId,
      plan: 'free',
      runs_per_month_cap: null,
      storage_bytes_cap: null,
      stripe_subscription_status: null,
      current_period_end: null,
      cancel_at: null,
      payment_failed_at: null,
    }]);
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: userId, status: 'active', role: 'member' },
      { id: randomUUID(), organization_id: orgId, user_id: ownerId, status: 'active', role: 'owner' },
    ]);

    // (a) Mint as the active member.
    const mintRes = await MINT(new Request('http://localhost/api/upload-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ runId, expectedChunkCount: 1 }),
    }));
    expect(mintRes.status).toBe(201);
    const mintBody = await mintRes.json();
    const token = mintBody.uploadToken as string;

    // (b) Owner disables the member via Phase 5.7 RPC.
    const disableResult = await stub.callRpc('disable_member', {
      p_caller_user_id: ownerId,
      p_org_id: orgId,
      p_target_user_id: userId,
    });
    expect(disableResult.error).toBeNull();

    // (c) Attempted event-write with the still-valid JWT.
    const evRes = await EVENT_WRITE(new Request(`http://localhost/api/runs/${runId}/events/0`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-ndjson',
        'x-chunk-prev-hash': zeroHash,
      },
      body: new Uint8Array(Buffer.from('{"event":"run.started"}\n')),
    }), { params: { runId, seq: '0' } });
    expect(evRes.status).toBe(403);
    const body = await evRes.json();
    expect(body.error).toBe('member_disabled');
  });
});
