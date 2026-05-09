import { createHash, timingSafeEqual } from 'crypto';
import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  _verifyUploadTokenInternal,
  type UploadTokenClaims,
} from './jwt';
import {
  assertActiveMembership,
  IngestMembershipError,
} from './membership-recheck';

export interface ResolvedCaller { userId: string }

export interface RunRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  deleted_at: string | null;
}

/**
 * Resolves the caller via, in order:
 *  1. NODE_ENV=test ONLY: `x-test-user` header (rejected outside test).
 *  2. `Authorization: Bearer <api_key>` against api_keys table; SHA256(key)
 *     compared with timingSafeEqual to api_keys.key_hash.
 *  3. Supabase SSR cookies (Phase 2.1's createServerClient).
 *
 * Returns null on auth failure. Routes turn null into 401.
 */
export async function resolveCaller(
  req: Request,
  serviceClient: SupabaseClient,
): Promise<ResolvedCaller | null> {
  // (1) Test-only seam — guard hard.
  if (process.env.NODE_ENV === 'test') {
    const u = req.headers.get('x-test-user');
    if (u) return { userId: u };
  } else if (req.headers.get('x-test-user')) {
    throw new Error('x-test-user header set in non-test env — refusing to honor');
  }

  // (2) API key.
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const key = auth.slice('Bearer '.length).trim();
    if (key.length >= 4) {
      const candidateHashHex = createHash('sha256').update(key).digest('hex');
      const candidateHash = Buffer.from(candidateHashHex, 'hex');
      const { data } = await serviceClient
        .from('api_keys')
        .select('user_id, key_hash, revoked_at')
        .is('revoked_at', null);
      if (data) {
        const rows = data as { user_id: string; key_hash: string }[];
        for (const row of rows) {
          // Test seam: rows can use the literal "hash-of-<key>" prefix to
          // simulate a stored hash without computing SHA256 in fixtures.
          if (process.env.NODE_ENV === 'test' && row.key_hash === `hash-of-${key}`) {
            return { userId: row.user_id };
          }
          let stored: Buffer;
          try { stored = Buffer.from(row.key_hash, 'hex'); } catch { continue; }
          if (stored.length !== candidateHash.length) continue;
          if (timingSafeEqual(stored, candidateHash)) {
            return { userId: row.user_id };
          }
        }
      }
    }
  }

  // (3) Supabase SSR session cookie (uses Phase 2.1's createServerClient).
  try {
    const cookieStore = await cookies();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return null;
    const ssr = createSsrServerClient(url, anon, {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {},  // route is read-only WRT auth cookies; no need to refresh here
      },
    });
    const { data: { user } } = await ssr.auth.getUser();
    if (user) return { userId: user.id };
  } catch {
    return null;
  }

  return null;
}

// ============================================================================
// v7.1 — JWT-authenticated ingest orchestrator.
//
// Single chokepoint that EVERY ingest route MUST call (event-write,
// finalize). Combines the JWT shape/signature check with the persisted-
// run consistency check + per-request membership re-check.
//
// Why this lives in `lib/upload/auth.ts` (vs the spec's `New file`
// suggestion): the file already exists with `resolveCaller`; both the
// session-mint and the ingest routes share an "upload auth" surface,
// so colocating keeps all upload-auth helpers in one module. ESLint
// `no-restricted-imports` forbids importing `@/lib/upload/jwt` from
// `app/api/runs/**` — routes MUST go through this orchestrator.
//
// Caller audit (kept current; mirrors the dashboard `auth.ts` block):
//   * /api/upload-session                  — mint endpoint. Uses
//     `resolveCaller` for cookie/api-key auth + does its own
//     `check_membership_status` RPC pre-mint (no JWT yet).
//   * /api/runs/:runId/events/:seq         — JWT-auth. MUST call
//     verifyTokenAndAssertRunMembership() before claim_chunk_slot.
//   * /api/runs/:runId/finalize            — JWT-auth. MUST call
//     verifyTokenAndAssertRunMembership() before manifest write.
//
// Future ingest endpoints touching org-scoped runs MUST add the same
// call. Direct imports of `verifyUploadToken` from `lib/upload/jwt`
// are blocked by ESLint in `app/api/runs/**` (defense-in-depth).
// ============================================================================

/**
 * v7.1 — orchestrator for JWT-authenticated ingest routes. Performs:
 *   1. JWT shape + signature verification (`_verifyUploadTokenInternal`).
 *   2. JWT.run_id ↔ route runId consistency check.
 *   3. Persisted runs lookup (single source of truth for organization_id).
 *   4. JWT.org_id ↔ persisted run.organization_id consistency check
 *      (closes cross-org JWT replay AND personal-shortcut bypass).
 *   5. Per-request membership re-check (active members only).
 *
 * Throws:
 *   - `TokenError` — JWT shape/signature/expiry. Route maps to 401.
 *   - `IngestMembershipError('run_mismatch'|'run_not_found'|
 *     'run_org_mismatch')` — wrapper-level. Route maps to 404 not_found
 *     (no enumeration leakage).
 *   - `IngestMembershipError('member_disabled'|'member_inactive'|
 *     'no_membership')` — Route maps to 403 with the reason.
 *   - `IngestMembershipError('member_check_failed')` — transient RPC
 *     failure. Route maps to 503 (retryable; CLI uploader retries 5xx).
 */
export async function verifyTokenAndAssertRunMembership(
  rawToken: string,
  routeRunId: string,
  supabase: SupabaseClient,
): Promise<{ claims: UploadTokenClaims; run: RunRow }> {
  // 1. JWT shape + signature.
  const claims = _verifyUploadTokenInternal(rawToken);

  // 2. Path/JWT run_id consistency (existing invariant — surfaced here).
  if (claims.run_id !== routeRunId) {
    throw new IngestMembershipError('run_mismatch');
  }

  // 3. Persisted-run lookup — single source of truth for organization_id.
  const { data: runData } = await supabase.from('runs')
    .select('id, user_id, organization_id, deleted_at')
    .eq('id', routeRunId)
    .maybeSingle();
  const run = runData as RunRow | null;
  if (!run || run.deleted_at) {
    throw new IngestMembershipError('run_not_found');
  }

  // 4. JWT org_id MUST match persisted run.organization_id (codex pass-3
  //    CRITICAL #2 — closes cross-org JWT replay AND personal-shortcut
  //    bypass). Both must be NULL (personal) or both non-null matching
  //    uuid (org-scoped). claims.org_id is normalized to null at verify
  //    time so the comparison is straight `===`.
  const tokenOrg = claims.org_id ?? null;
  if (tokenOrg !== run.organization_id) {
    throw new IngestMembershipError('run_org_mismatch');
  }

  // 5. JWT sub MUST match persisted run.user_id (codex PR-pass CRITICAL —
  //    prevents a malformed/forged signed token where `run_id` points to
  //    one user's run and `sub` points to a different active org member.
  //    Without this, assertActiveMembership(claims) would validate the
  //    wrong principal's membership against the target run). Maps to
  //    opaque 404 not_found at the HTTP layer (no enumeration leakage).
  if (claims.sub !== run.user_id) {
    throw new IngestMembershipError('run_user_mismatch');
  }

  // 6. Membership re-check (only for org-scoped — personal short-circuits
  //    safely now that step 4 proves the run is genuinely personal).
  await assertActiveMembership(claims);

  return { claims, run };
}
