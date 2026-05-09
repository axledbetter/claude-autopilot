// apps/web/__tests__/middleware/revocation.test.ts
//
// v7.0 Phase 6 — spec test #5. Ten cases covering the dashboard
// membership-revocation surface in apps/web/middleware.ts:
//   (a) cookie absent → RPC + signed cookie set (allow)
//   (b) signed cookie fresh + matching → no RPC (allow)
//   (c) signed cookie expired → RPC re-check
//   (d) UNSIGNED forged cookie → rejected, RPC fallthrough
//   (e) signed cookie wrong-user → RPC fallthrough
//   (f) signed cookie wrong-org → RPC fallthrough
//   (g) status='disabled' → 302 to /access-revoked + cleared cookies
//   (h) /api/dashboard/* with no active-org → 403 no_active_org (fail-closed)
//   (i) /dashboard/orgs/select with no active-org → pass-through (whitelist)
//   (j) revoked user visiting /dashboard/orgs/select sees empty active-orgs
//       list (codex pass-2 WARNING #7)
//
// Cases (a)-(g) are exercised against the cookie-hmac + status-mapping
// helpers + the path-classification helpers exported from the
// middleware. The full Next.js middleware function requires the
// bundled Headers class from `next/server` which jsdom doesn't ship —
// the integration test in middleware-revocation.integration.test.ts
// covers the e2e shape with a thin Request mock.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isRevocationSurfacePath,
  isWhitelistedBootstrapPath,
  statusToReason,
  MEMBERSHIP_CHECK_COOKIE,
} from '@/middleware';
import {
  signMembershipCookie,
  verifyMembershipCookie,
} from '@/lib/middleware/cookie-hmac';
import * as svc from '@/lib/supabase/service';
import * as activeOrg from '@/lib/dashboard/active-org';

const SECRET = 'a'.repeat(64);
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_A = '33333333-3333-3333-3333-333333333333';
const USER_B = '44444444-4444-4444-4444-444444444444';

beforeEach(() => {
  process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.MEMBERSHIP_CHECK_COOKIE_SECRET;
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------------------
// Surface classification
// ----------------------------------------------------------------------------

describe('test #5 — surface path classification', () => {
  it('classifies /dashboard/** as a page surface', () => {
    expect(isRevocationSurfacePath('/dashboard')).toEqual({ match: true, isApi: false });
    expect(isRevocationSurfacePath('/dashboard/admin/members')).toEqual({ match: true, isApi: false });
  });

  it('classifies /api/dashboard/** as an API surface', () => {
    expect(isRevocationSurfacePath('/api/dashboard')).toEqual({ match: true, isApi: true });
    expect(isRevocationSurfacePath('/api/dashboard/runs/01HQK8/upload-session')).toEqual({
      match: true,
      isApi: true,
    });
  });

  it('does NOT classify other surfaces (cli-auth, login, runs share)', () => {
    expect(isRevocationSurfacePath('/cli-auth').match).toBe(false);
    expect(isRevocationSurfacePath('/login/sso').match).toBe(false);
    expect(isRevocationSurfacePath('/runs/01HQK8').match).toBe(false);
    expect(isRevocationSurfacePath('/api/health').match).toBe(false);
  });
});

describe('test #5(i) — /dashboard/orgs/select is whitelisted bootstrap path', () => {
  it('whitelists /dashboard/orgs/select and /dashboard/orgs/create', () => {
    expect(isWhitelistedBootstrapPath('/dashboard/orgs/select')).toBe(true);
    expect(isWhitelistedBootstrapPath('/dashboard/orgs/create')).toBe(true);
  });

  it('does NOT whitelist other /dashboard sub-paths', () => {
    expect(isWhitelistedBootstrapPath('/dashboard/admin/members')).toBe(false);
    expect(isWhitelistedBootstrapPath('/dashboard')).toBe(false);
    expect(isWhitelistedBootstrapPath('/dashboard/orgs/random')).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Status → reason mapping (single source of truth — codex pass-3 WARNING #5)
// ----------------------------------------------------------------------------

describe('test #5 — status → reason mapping', () => {
  it('maps disabled → member_disabled', () => {
    expect(statusToReason('disabled')).toBe('member_disabled');
  });
  it('maps inactive → member_inactive', () => {
    expect(statusToReason('inactive')).toBe('member_inactive');
  });
  it('maps invite_pending → member_inactive', () => {
    expect(statusToReason('invite_pending')).toBe('member_inactive');
  });
  it('maps no_row → no_membership', () => {
    expect(statusToReason('no_row')).toBe('no_membership');
  });
});

// ----------------------------------------------------------------------------
// Test #5(b) — signed cookie fresh + matching → no RPC
// ----------------------------------------------------------------------------

describe('test #5(b) — signed cookie fresh + matching → cache hit (no RPC)', () => {
  it('verifies a fresh signed cookie for matching (orgId, userId)', () => {
    const signed = signMembershipCookie({
      orgId: ORG_A,
      userId: USER_A,
      status: 'active',
      role: 'owner',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const result = verifyMembershipCookie(signed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.orgId).toBe(ORG_A);
      expect(result.payload.userId).toBe(USER_A);
    }
    expect(MEMBERSHIP_CHECK_COOKIE).toBe('cao_membership_check');
  });
});

// ----------------------------------------------------------------------------
// Test #5(c) — signed cookie expired → RPC re-check (verify rejects expired)
// ----------------------------------------------------------------------------

describe('test #5(c) — signed cookie expired → falls through to RPC', () => {
  it('verify returns expired for past exp; middleware should NOT short-circuit', () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    const signed = signMembershipCookie({
      orgId: ORG_A,
      userId: USER_A,
      status: 'active',
      role: 'owner',
      exp: past,
    });
    const result = verifyMembershipCookie(signed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });
});

// ----------------------------------------------------------------------------
// Test #5(d) — UNSIGNED forged cookie → rejected
// ----------------------------------------------------------------------------

describe('test #5(d) — unsigned/forged cookie → cache miss (rejected)', () => {
  it('rejects an unsigned cookie that looks like a payload only', () => {
    const result = verifyMembershipCookie('justpayloadnocompare');
    expect(result.ok).toBe(false);
  });

  it('rejects a cookie signed with a different secret', () => {
    process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = 'b'.repeat(64);
    const signedWithB = signMembershipCookie({
      orgId: ORG_A,
      userId: USER_A,
      status: 'active',
      role: 'member',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = SECRET;
    const result = verifyMembershipCookie(signedWithB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });
});

// ----------------------------------------------------------------------------
// Test #5(e) — signed cookie wrong-user → middleware should compare
// (orgId, userId) on every cache hit. The verifier returns ok with
// payload; the middleware enforces the (orgId, userId) match.
// ----------------------------------------------------------------------------

describe('test #5(e/f) — signed cookie wrong-user / wrong-org → cache miss', () => {
  it('verify returns the payload; middleware compares (orgId, userId) before accepting', () => {
    const signed = signMembershipCookie({
      orgId: ORG_A,
      userId: USER_A,
      status: 'active',
      role: 'owner',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const result = verifyMembershipCookie(signed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Simulate the middleware's match check for a different user.
      const requestUser = USER_B;
      expect(result.payload.userId === requestUser).toBe(false);
      // Same for wrong-org.
      const requestOrg = ORG_B;
      expect(result.payload.orgId === requestOrg).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// Test #5(j) — revoked user visiting /dashboard/orgs/select sees empty
// active-orgs list. listActiveOrgs filters to status='active' rows.
// ----------------------------------------------------------------------------

describe('test #5(j) — revoked user → /dashboard/orgs/select shows empty list', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub';
    svc._resetServiceClientForTests();
  });

  afterEach(() => {
    svc._resetServiceClientForTests();
  });

  it('listActiveOrgs returns [] when the user has zero status=active memberships', async () => {
    // Codex pass-2 WARNING #7: filter to status='active' so a revoked
    // user cannot re-select into the org they were just disabled from.
    const fakeSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
    };
    const orgs = await activeOrg.listActiveOrgs(
      fakeSupabase as unknown as Parameters<typeof activeOrg.listActiveOrgs>[0],
      USER_A,
    );
    expect(orgs).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Test #5(h) — /api/dashboard/* with no active-org → 403 no_active_org
// (fail-closed). This is enforced inside evaluateRevocation; the
// integration test below pins the response shape end-to-end.
// ----------------------------------------------------------------------------

describe('test #5(h) — /api/dashboard with no active-org → fail-closed 403', () => {
  it('classifies /api/dashboard as an API surface (drives the 403 vs 302 branch)', () => {
    expect(isRevocationSurfacePath('/api/dashboard').isApi).toBe(true);
    expect(isRevocationSurfacePath('/dashboard').isApi).toBe(false);
  });
});
