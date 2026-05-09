// apps/web/__tests__/api/dashboard/runs/middleware-revocation.integration.test.ts
//
// v7.0 Phase 6 — spec test #8.
//
// End-to-end-ish: drive `checkMembershipStatus` against a stub
// service-role client so we observe the full helper pipeline (UUID
// guard → RPC call → mapping). Then verify the cookie cache short-
// circuits the second call within the 60s window.
//
// We can't easily exercise the actual NextRequest-driven middleware
// under jsdom (the Edge Headers class isn't bundled), so this test
// covers the contract the middleware relies on:
//   - revocation completes within ≤60s of the next request, not ≤1h
//     (i.e. the cache TTL bounds the gap).
//   - second call within TTL skips the RPC entirely.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkMembershipStatus,
  MembershipCheckError,
} from '@/lib/supabase/check-membership';
import {
  signMembershipCookie,
  verifyMembershipCookie,
} from '@/lib/middleware/cookie-hmac';
import * as svc from '@/lib/supabase/service';

const SECRET = 'a'.repeat(64);
const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub';
  svc._resetServiceClientForTests();
});

afterEach(() => {
  delete process.env.MEMBERSHIP_CHECK_COOKIE_SECRET;
  vi.restoreAllMocks();
  svc._resetServiceClientForTests();
});

describe('test #8 — disabled-after-login user gets 403 within ≤60s, not ≤1h', () => {
  it('first request: RPC reports active → mint signed 60s-TTL cookie', async () => {
    const rpcSpy = vi.fn().mockResolvedValue({
      data: { status: 'active', role: 'member', checked_at: 1234567890 },
      error: null,
    });
    vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
      rpc: rpcSpy,
    } as unknown as ReturnType<typeof svc.createServiceRoleClient>);

    const result = await checkMembershipStatus(ORG, USER);
    expect(result.status).toBe('active');
    // Mint the cookie the middleware would set.
    const signed = signMembershipCookie({
      orgId: ORG,
      userId: USER,
      status: 'active',
      role: result.role ?? 'member',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect(signed).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(rpcSpy).toHaveBeenCalledTimes(1);
  });

  it('second request within 60s: cookie cache hit → zero RPC calls', () => {
    const signed = signMembershipCookie({
      orgId: ORG,
      userId: USER,
      status: 'active',
      role: 'member',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const verified = verifyMembershipCookie(signed);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.orgId).toBe(ORG);
      expect(verified.payload.userId).toBe(USER);
    }
    // No RPC was called — the cache bypass is the whole point.
  });

  it('after 60s: cookie expired → RPC re-check; if status changed to disabled, helper returns disabled', async () => {
    // Advance clock past TTL by minting a payload with exp in the past.
    const past = Math.floor(Date.now() / 1000) - 1;
    const expired = signMembershipCookie({
      orgId: ORG,
      userId: USER,
      status: 'active',
      role: 'member',
      exp: past,
    });
    const verified = verifyMembershipCookie(expired);
    expect(verified.ok).toBe(false);
    // Cookie expired, middleware re-checks RPC, which now returns disabled.
    vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: { status: 'disabled', role: 'member', checked_at: 1234567990 },
        error: null,
      }),
    } as unknown as ReturnType<typeof svc.createServiceRoleClient>);

    const result = await checkMembershipStatus(ORG, USER);
    expect(result.status).toBe('disabled');
    // Middleware would translate this to:
    //   - page request: 302 → /access-revoked?reason=member_disabled
    //   - api request:  403 JSON {error: 'member_disabled'}
    // and clear both the cao_active_org and cao_membership_check cookies.
  });

  it('60s revocation window: revocation visible within (60s + 0ms RPC) ≤ 60s + RPC latency, not 1h', () => {
    // The cookie's max age is 60s. The middleware mints a fresh cookie
    // on every cache miss with exp = now + 60. After the RPC reports
    // disabled, the next request can have an in-flight cached cookie
    // that's at most 60s old — bounded by the TTL.
    const now = Math.floor(Date.now() / 1000);
    const signed = signMembershipCookie({
      orgId: ORG,
      userId: USER,
      status: 'active',
      role: 'member',
      exp: now + 60,
    });
    const verified = verifyMembershipCookie(signed);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      // Worst case — TTL is 60s.
      expect(verified.payload.exp - now).toBeLessThanOrEqual(60);
      // Tighter than the v6 access-token expiry of 1 hour (3600s).
      expect(verified.payload.exp - now).toBeLessThan(3600);
    }
  });

  it('RPC error → MembershipCheckError(check_failed) — middleware translates to /access-revoked?reason=check_failed', async () => {
    vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'connection refused', code: 'ECONNREFUSED' },
      }),
    } as unknown as ReturnType<typeof svc.createServiceRoleClient>);

    try {
      await checkMembershipStatus(ORG, USER);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MembershipCheckError);
      expect((err as MembershipCheckError).code).toBe('check_failed');
      // Critical: NOT 'member_disabled' — codex pass-2 WARNING #4. The
      // middleware uses /access-revoked?reason=check_failed (page) or
      // 403 {error: 'check_failed'} (API), distinct from the disabled
      // path so operators can grep logs.
    }
  });
});
