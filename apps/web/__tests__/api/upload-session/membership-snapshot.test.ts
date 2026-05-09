// apps/web/__tests__/api/upload-session/membership-snapshot.test.ts
//
// v7.1 spec test #1 — mint endpoint embeds the membership-status snapshot.
//
// Coverage:
//   (a) org-scoped active member → 201 with mint_status: 'active' in JWT
//   (b) org-scoped disabled member → 403 member_not_active + audit_events
//       row + NO upload_sessions row
//   (c) personal run (organization_id IS NULL) → 201 with mint_status:
//       'personal' (and the check_membership_status RPC was NOT called)
//   (d) RPC error → 503 member_check_failed (codex pass-2 WARNING #2 —
//       retryable parity with event-write/finalize), NO upload_sessions row

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

function seedOrgRun(): { runId: string; userId: string; orgId: string } {
  const userId = randomUUID();
  const orgId = randomUUID();
  const runId = '01HQK8' + 'A'.repeat(20);
  stub.seed('runs', [{ id: runId, user_id: userId, organization_id: orgId }]);
  // Entitlements row is seeded by trigger in prod; the stub doesn't run
  // triggers, so we seed manually with the free-plan defaults.
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
  return { runId, userId, orgId };
}

function seedPersonalRun(): { runId: string; userId: string } {
  const userId = randomUUID();
  const runId = '01HQK8' + 'P'.repeat(20);
  stub.seed('runs', [{ id: runId, user_id: userId, organization_id: null }]);
  return { runId, userId };
}

describe('POST /api/upload-session — v7.1 mint-time membership snapshot', () => {
  it('(a) org-scoped active member → 201 with mint_status: active in JWT', async () => {
    const { runId, userId, orgId } = seedOrgRun();
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: userId, status: 'active', role: 'owner' },
    ]);
    const res = await POST(makeReq({ runId, expectedChunkCount: 1 }, { 'x-test-user': userId }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const decoded = jwt.verify(body.uploadToken, SECRET) as Record<string, unknown>;
    expect(decoded.mint_status).toBe('active');
    expect(decoded.org_id).toBe(orgId);
  });

  it('(b) org-scoped disabled member → 403 member_not_active + audit row + no upload_sessions row', async () => {
    const { runId, userId, orgId } = seedOrgRun();
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: userId, status: 'disabled', role: 'member' },
    ]);
    const res = await POST(makeReq({ runId, expectedChunkCount: 1 }, { 'x-test-user': userId }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('member_not_active');

    const sessions = stub.tables.get('upload_sessions') ?? [];
    expect(sessions.length).toBe(0);

    const audits = stub.tables.get('audit_events') ?? [];
    const refusal = audits.find((a) => a.action === 'ingest.mint_refused');
    expect(refusal).toBeDefined();
    expect(refusal?.organization_id).toBe(orgId);
    const meta = refusal?.metadata as Record<string, unknown>;
    expect(meta.run_id).toBe(runId);
    expect(meta.organization_id).toBe(orgId);
    expect(meta.user_id).toBe(userId);
    expect(meta.reason).toBe('member_not_active');
  });

  it('(c) personal run → 201 with mint_status: personal (no membership RPC call)', async () => {
    const { runId, userId } = seedPersonalRun();
    // Spy on rpc dispatch — check_membership_status MUST NOT be called for
    // personal runs (no organization_id to check against).
    const callRpcSpy = vi.spyOn(stub, 'callRpc');
    const res = await POST(makeReq({ runId, expectedChunkCount: 1 }, { 'x-test-user': userId }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const decoded = jwt.verify(body.uploadToken, SECRET) as Record<string, unknown>;
    expect(decoded.mint_status).toBe('personal');
    // Personal-run wire format: org_id serializes as ''
    expect(decoded.org_id).toBe('');

    const membershipRpcCalls = callRpcSpy.mock.calls.filter(
      ([fn]) => fn === 'check_membership_status',
    );
    expect(membershipRpcCalls.length).toBe(0);
    callRpcSpy.mockRestore();
  });

  it('(d) RPC error during membership check → 503 member_check_failed + no upload_sessions row', async () => {
    const { runId, userId, orgId } = seedOrgRun();
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: userId, status: 'active', role: 'owner' },
    ]);
    // Force the membership RPC to fail.
    const original = stub.callRpc.bind(stub);
    const callRpcSpy = vi.spyOn(stub, 'callRpc').mockImplementation(async (fn, args) => {
      if (fn === 'check_membership_status') {
        return { data: null, error: { code: 'P0001', message: 'simulated rpc failure' } };
      }
      return original(fn, args);
    });
    const res = await POST(makeReq({ runId, expectedChunkCount: 1 }, { 'x-test-user': userId }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('member_check_failed');

    const sessions = stub.tables.get('upload_sessions') ?? [];
    expect(sessions.length).toBe(0);

    callRpcSpy.mockRestore();
  });
});
