// apps/web/lib/dashboard/assert-active-membership-for-org.ts
//
// v7.5.0 — defense-in-depth helper for high-sensitivity dashboard
// route handlers (CRITICAL #3 from codex pass-2).
//
// The middleware (`apps/web/middleware.ts`) is the OUTER optimization:
// for high-sensitivity routes it skips the cookie cache and runs the
// RPC. But middleware regex matching is brittle — a new sensitive
// route handler that isn't yet in `HIGH_SENSITIVITY_PATTERNS` would
// silently default to the cached path. To prevent that being a
// security hole, every high-sensitivity route handler MUST call
// `assertActiveMembershipForOrg()` at the very top, BEFORE any other
// authorization. This is the INNER correctness gate.
//
// Behavior:
//  - Validates orgId / userId are UUIDs (defense in depth; downstream
//    `check_membership_status` also validates).
//  - Calls Phase 6 `check_membership_status` RPC.
//  - On success (status='active') returns `{ status, role }`.
//  - On any negative result throws `MembershipCheckError` with one
//    of: 'member_disabled' | 'member_inactive' | 'no_membership' |
//    'check_failed'.
//
// Route handlers should catch `MembershipCheckError` and return 403
// JSON `{ error: <code> }` with no further DB work. Example:
//
//     try {
//       await assertActiveMembershipForOrg({ orgId, userId, supabase });
//     } catch (err) {
//       if (err instanceof MembershipCheckError) {
//         return NextResponse.json({ error: err.code }, { status: 403 });
//       }
//       throw err;
//     }
//
// A v7.6+ wrapper helper `withActiveMembershipRequired()` will fold
// this boilerplate into a single decorator; for v7.5.0 the explicit
// call is sufficient.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  checkMembershipStatus,
  MembershipCheckError as UpstreamMembershipCheckError,
  type MembershipStatus,
  type MembershipRole,
} from '@/lib/supabase/check-membership';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AssertMembershipErrorCode =
  | 'member_disabled'
  | 'member_inactive'
  | 'no_membership'
  | 'check_failed';

export class MembershipCheckError extends Error {
  readonly code: AssertMembershipErrorCode;
  readonly subcode?: string;
  override readonly cause?: unknown;

  constructor(opts: {
    code: AssertMembershipErrorCode;
    subcode?: string;
    message?: string;
    cause?: unknown;
  }) {
    super(opts.message ?? opts.code);
    this.name = 'MembershipCheckError';
    this.code = opts.code;
    if (opts.subcode !== undefined) this.subcode = opts.subcode;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

function statusToCode(status: MembershipStatus): AssertMembershipErrorCode {
  switch (status) {
    case 'disabled':
      return 'member_disabled';
    case 'inactive':
    case 'invite_pending':
      return 'member_inactive';
    case 'no_row':
      return 'no_membership';
    case 'active':
      // Unreachable; only called when status !== 'active'.
      return 'check_failed';
  }
}

export interface AssertActiveMembershipOptions {
  orgId: string;
  userId: string;
  /** Optional injection seam for tests + handler reuse. Falls back to
   *  the shared service-role client when not provided. The arg is
   *  kept for API stability — internal calls go through
   *  `checkMembershipStatus` which acquires its own service-role
   *  client. */
  supabase?: SupabaseClient;
}

export interface AssertActiveMembershipResult {
  status: 'active';
  role: MembershipRole;
}

/**
 * Asserts that (orgId, userId) is an `active` membership in
 * `org_members`. Uses the Phase 6 `check_membership_status` RPC.
 *
 * Throws `MembershipCheckError` with a stable `code` on failure.
 * Returns `{ status: 'active', role }` on success.
 */
export async function assertActiveMembershipForOrg(
  opts: AssertActiveMembershipOptions,
): Promise<AssertActiveMembershipResult> {
  const { orgId, userId } = opts;

  if (typeof orgId !== 'string' || !UUID_RE.test(orgId)) {
    throw new MembershipCheckError({
      code: 'check_failed',
      subcode: 'invalid_org_id',
      message: 'orgId is not a valid UUID',
    });
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new MembershipCheckError({
      code: 'check_failed',
      subcode: 'invalid_user_id',
      message: 'userId is not a valid UUID',
    });
  }

  // Touch the optional supabase arg so callers can inject for future
  // expansion. Today the call resolves to the shared service-role
  // client inside `checkMembershipStatus`.
  void (opts.supabase ?? createServiceRoleClient);

  let result: { status: MembershipStatus; role: MembershipRole };
  try {
    result = await checkMembershipStatus(orgId, userId);
  } catch (err) {
    if (err instanceof UpstreamMembershipCheckError) {
      throw new MembershipCheckError({
        code: 'check_failed',
        subcode: err.subcode ?? err.code,
        message: err.message,
        cause: err,
      });
    }
    throw new MembershipCheckError({
      code: 'check_failed',
      subcode: 'unknown',
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    });
  }

  if (result.status !== 'active') {
    throw new MembershipCheckError({
      code: statusToCode(result.status),
      message: `membership status is ${result.status}`,
    });
  }

  return { status: 'active', role: result.role };
}

/**
 * Convenience: produce the canonical 403 JSON `Response` for a
 * MembershipCheckError. Handlers can short-circuit:
 *
 *     try {
 *       await assertActiveMembershipForOrg({ orgId, userId });
 *     } catch (err) {
 *       const r = respondToMembershipError(err);
 *       if (r) return r;
 *       throw err;
 *     }
 */
export function respondToMembershipError(err: unknown): Response | null {
  if (!(err instanceof MembershipCheckError)) return null;
  return new Response(JSON.stringify({ error: err.code }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}
