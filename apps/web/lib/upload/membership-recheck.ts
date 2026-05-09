// apps/web/lib/upload/membership-recheck.ts
//
// v7.1 — per-request membership re-check on JWT-authenticated ingest
// surfaces (`PUT /api/runs/:runId/events/:seq`,
// `POST /api/runs/:runId/finalize`).
//
// Together with the v7.0 Phase 6 cookie middleware (≤60s revocation on
// dashboard surfaces), this collapses the symmetric ingest revocation
// window from ≤15min (the JWT TTL) to ≤1 request for org-scoped runs.
//
// Authority is `claims.org_id` — `mint_status` is observability-only
// (codex pass-1 CRITICAL #2).

import {
  checkMembershipStatus,
  MembershipCheckError,
} from '@/lib/supabase/check-membership';
import type { UploadTokenClaims } from './jwt';

export type IngestMembershipReason =
  | 'member_disabled'
  | 'member_inactive'
  | 'no_membership'
  | 'member_check_failed'
  // Wrapper-level reasons, raised by verifyTokenAndAssertRunMembership()
  // before assertActiveMembership() runs. All three map to 404 not_found
  // at the HTTP layer (no enumeration leakage).
  | 'run_mismatch'
  | 'run_not_found'
  | 'run_org_mismatch';

export class IngestMembershipError extends Error {
  constructor(public readonly reason: IngestMembershipReason) {
    super(`ingest membership refused: ${reason}`);
    this.name = 'IngestMembershipError';
  }
}

/**
 * Assert that the JWT principal is an active member of the run's org.
 *
 * Authority: `claims.org_id`. Personal runs (org_id null/empty) skip
 * the check; org-scoped runs ALWAYS call the RPC, regardless of the
 * (cosmetic) `mint_status` claim. This is the codex pass-1 CRITICAL #2
 * fix — `mint_status` is observability-only, NOT authorization.
 *
 * Codex pass-1 CRITICAL #1: explicit fail-closed default branch on
 * unknown statuses.
 *
 * Codex pass-3 WARNING #4: broad catch around `checkMembershipStatus`
 * — any RPC/network/timeout failure becomes `member_check_failed`
 * (mapped to retryable HTTP 503 at route layer). Programmer errors
 * (TypeError on undefined etc.) bubble up as 500.
 */
export async function assertActiveMembership(claims: UploadTokenClaims): Promise<void> {
  // Personal-run shortcut. org_id is the SOLE authority.
  // The wrapper (verifyTokenAndAssertRunMembership) has already
  // verified that the persisted run.organization_id is also null
  // before calling this function — eliminates the "personal-shortcut
  // bypass" (codex pass-3 CRITICAL #2).
  if (!claims.org_id) return;

  let result;
  try {
    result = await checkMembershipStatus(claims.org_id, claims.sub);
  } catch (err) {
    // Codex pass-3 WARNING #4 — broad catch: ANY RPC/network/timeout
    // failure becomes member_check_failed (retryable 503). Programmer
    // errors (TypeError on undefined etc.) bubble up as 500 — no
    // attempt to silence those.
    if (err instanceof MembershipCheckError) {
      throw new IngestMembershipError('member_check_failed');
    }
    if (err && typeof err === 'object' && 'message' in err) {
      // Non-MembershipCheckError but non-programmer (network/timeout)
      // — wrap defensively so one ill-classified Supabase error doesn't
      // turn into a 500.
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({
        msg: 'ingest.unexpected_rpc_error',
        runId: claims.run_id,
        jti: claims.jti,
        orgId: claims.org_id,
        err: String((err as Error).message),
      }));
      throw new IngestMembershipError('member_check_failed');
    }
    throw err;
  }

  switch (result.status) {
    case 'active':
      return;
    case 'disabled':
      throw new IngestMembershipError('member_disabled');
    case 'inactive':
    case 'invite_pending':
      throw new IngestMembershipError('member_inactive');
    case 'no_row':
      throw new IngestMembershipError('no_membership');
    default:
      // Codex pass-1 CRITICAL #1 — fail-closed on any unknown status.
      // Codex pass-2 NOTE #3 — structured log line (run_id, jti, org_id
      // included; sub deliberately omitted to avoid PII spread).
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({
        msg: 'ingest.unknown_membership_status',
        status: result.status,
        runId: claims.run_id,
        jti: claims.jti,
        orgId: claims.org_id,
      }));
      throw new IngestMembershipError('member_check_failed');
  }
}
