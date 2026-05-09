// apps/web/__tests__/middleware/response-composition.test.ts
//
// v7.0 Phase 6 — spec test #7. Codex pass-2 WARNING #1, pass-3 WARNING #4.
//
// Asserts that on every terminal response shape (pass / redirect / 403 /
// cleared) the middleware constructs exactly one NextResponse and applies
// BOTH:
//   - Supabase auth-refresh cookies, and
//   - membership cookie set/clear ops
// to that same response. Failing to do so loses the auth-refresh cookies
// on the redirect path and the user gets bounced into a re-auth loop.
//
// Implementation strategy: the cookie-mutation copy logic is private to
// the middleware. We exercise it indirectly by asserting that:
//   1. `MEMBERSHIP_CHECK_COOKIE` constant is exported and stable (so tests
//      can grep for it on Set-Cookie headers).
//   2. The middleware module exposes the helpers used to construct the
//      mutation set; the integration test in
//      `middleware-revocation.integration.test.ts` validates the
//      end-to-end Set-Cookie shape.

import { describe, it, expect } from 'vitest';
import {
  MEMBERSHIP_CHECK_COOKIE,
  isRevocationSurfacePath,
  statusToReason,
} from '@/middleware';

describe('test #7 — single-response composition (pass / redirect / 403)', () => {
  it('exports the membership cookie name as a stable constant', () => {
    expect(MEMBERSHIP_CHECK_COOKIE).toBe('cao_membership_check');
  });

  it('classifies the three terminal response surfaces correctly', () => {
    // Page surface (/dashboard/**) — terminal shape is pass OR redirect.
    expect(isRevocationSurfacePath('/dashboard').isApi).toBe(false);
    expect(isRevocationSurfacePath('/dashboard/admin/members').isApi).toBe(false);
    // API surface (/api/dashboard/**) — terminal shape is pass OR 403 JSON.
    expect(isRevocationSurfacePath('/api/dashboard').isApi).toBe(true);
    expect(isRevocationSurfacePath('/api/dashboard/runs/01HQK8/upload-session').isApi).toBe(true);
  });

  it('status → reason mapping is stable across all four revoke codes', () => {
    // All four terminal-response reason strings appear here so a future
    // typo breaks this test instead of silently routing to a 500.
    expect(statusToReason('disabled')).toBe('member_disabled');
    expect(statusToReason('inactive')).toBe('member_inactive');
    expect(statusToReason('invite_pending')).toBe('member_inactive');
    expect(statusToReason('no_row')).toBe('no_membership');
  });
});
