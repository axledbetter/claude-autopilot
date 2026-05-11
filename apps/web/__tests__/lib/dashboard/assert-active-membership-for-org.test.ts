// apps/web/__tests__/lib/dashboard/assert-active-membership-for-org.test.ts
//
// v7.5.0 — unit tests for the defense-in-depth membership helper.
//
// Covers the 4 error codes (`member_disabled`, `member_inactive`,
// `no_membership`, `check_failed`) + happy path + UUID validation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  assertActiveMembershipForOrg,
  MembershipCheckError,
  respondToMembershipError,
} from '@/lib/dashboard/assert-active-membership-for-org';
import * as svc from '@/lib/supabase/service';

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '33333333-3333-3333-3333-333333333333';

function stubRpc(result: { status: string; role: string | null }) {
  vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
    rpc: vi.fn().mockResolvedValue({
      data: { ...result, checked_at: 1234567890 },
      error: null,
    }),
  } as unknown as ReturnType<typeof svc.createServiceRoleClient>);
}

function stubRpcError(error: { message: string; code?: string }) {
  vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
    rpc: vi.fn().mockResolvedValue({ data: null, error }),
  } as unknown as ReturnType<typeof svc.createServiceRoleClient>);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub';
  svc._resetServiceClientForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  svc._resetServiceClientForTests();
});

describe('assertActiveMembershipForOrg — happy path', () => {
  it('status=active → returns { status: active, role }', async () => {
    stubRpc({ status: 'active', role: 'owner' });
    const r = await assertActiveMembershipForOrg({ orgId: ORG, userId: USER });
    expect(r.status).toBe('active');
    expect(r.role).toBe('owner');
  });

  it('status=active with member role', async () => {
    stubRpc({ status: 'active', role: 'member' });
    const r = await assertActiveMembershipForOrg({ orgId: ORG, userId: USER });
    expect(r.role).toBe('member');
  });
});

describe('assertActiveMembershipForOrg — error codes', () => {
  it('status=disabled → throws MembershipCheckError(member_disabled)', async () => {
    stubRpc({ status: 'disabled', role: 'member' });
    let caught: unknown;
    try { await assertActiveMembershipForOrg({ orgId: ORG, userId: USER }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MembershipCheckError);
    expect((caught as MembershipCheckError).code).toBe('member_disabled');
  });

  it('status=inactive → throws MembershipCheckError(member_inactive)', async () => {
    stubRpc({ status: 'inactive', role: 'member' });
    let caught: unknown;
    try { await assertActiveMembershipForOrg({ orgId: ORG, userId: USER }); }
    catch (e) { caught = e; }
    expect((caught as MembershipCheckError).code).toBe('member_inactive');
  });

  it('status=invite_pending → also member_inactive (single user-visible bucket)', async () => {
    stubRpc({ status: 'invite_pending', role: null });
    let caught: unknown;
    try { await assertActiveMembershipForOrg({ orgId: ORG, userId: USER }); }
    catch (e) { caught = e; }
    expect((caught as MembershipCheckError).code).toBe('member_inactive');
  });

  it('status=no_row → throws MembershipCheckError(no_membership)', async () => {
    stubRpc({ status: 'no_row', role: null });
    let caught: unknown;
    try { await assertActiveMembershipForOrg({ orgId: ORG, userId: USER }); }
    catch (e) { caught = e; }
    expect((caught as MembershipCheckError).code).toBe('no_membership');
  });

  it('RPC error → throws MembershipCheckError(check_failed)', async () => {
    stubRpcError({ message: 'connection refused', code: 'ECONNREFUSED' });
    let caught: unknown;
    try { await assertActiveMembershipForOrg({ orgId: ORG, userId: USER }); }
    catch (e) { caught = e; }
    expect((caught as MembershipCheckError).code).toBe('check_failed');
  });
});

describe('assertActiveMembershipForOrg — input validation', () => {
  it('invalid orgId → throws MembershipCheckError(check_failed) with invalid_org_id subcode', async () => {
    // Don't stub RPC — invalid orgId must fail BEFORE the RPC fires.
    let caught: unknown;
    try { await assertActiveMembershipForOrg({ orgId: 'not-a-uuid', userId: USER }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MembershipCheckError);
    expect((caught as MembershipCheckError).code).toBe('check_failed');
    expect((caught as MembershipCheckError).subcode).toBe('invalid_org_id');
  });

  it('invalid userId → throws MembershipCheckError(check_failed) with invalid_user_id subcode', async () => {
    let caught: unknown;
    try { await assertActiveMembershipForOrg({ orgId: ORG, userId: 'nope' }); }
    catch (e) { caught = e; }
    expect((caught as MembershipCheckError).code).toBe('check_failed');
    expect((caught as MembershipCheckError).subcode).toBe('invalid_user_id');
  });

  it('empty orgId → fails validation', async () => {
    let caught: unknown;
    try { await assertActiveMembershipForOrg({ orgId: '', userId: USER }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MembershipCheckError);
  });
});

describe('respondToMembershipError', () => {
  it('returns a 403 JSON Response for MembershipCheckError', async () => {
    const err = new MembershipCheckError({ code: 'member_disabled' });
    const r = respondToMembershipError(err);
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
    const body = (await r!.json()) as { error: string };
    expect(body.error).toBe('member_disabled');
    // Defense in depth — these endpoints must never be cacheable.
    expect(r!.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns null for non-MembershipCheckError values (caller rethrows)', () => {
    expect(respondToMembershipError(new Error('something else'))).toBeNull();
    expect(respondToMembershipError(null)).toBeNull();
    expect(respondToMembershipError(undefined)).toBeNull();
    expect(respondToMembershipError('a string')).toBeNull();
  });

  it('preserves the error code in body for each variant', async () => {
    for (const code of ['member_disabled', 'member_inactive', 'no_membership', 'check_failed'] as const) {
      const r = respondToMembershipError(new MembershipCheckError({ code }));
      expect(r).not.toBeNull();
      const body = (await r!.json()) as { error: string };
      expect(body.error).toBe(code);
    }
  });
});
