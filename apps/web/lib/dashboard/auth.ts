import { createHash } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';

// ============================================================================
// API-key auth + the org-membership invariant (Phase 5.8 audit).
//
// Codex PR-pass WARNING #3 — every authViaApiKey caller that operates on
// org-scoped resources MUST require an active membership for auth.userId
// in the relevant organization. authViaApiKey itself returns user only —
// no org context — because API keys are user-scoped.
//
// Caller audit (kept current as new routes are added):
//   * /api/dashboard/api-keys/revoke — user-scoped (revoke own keys). N/A.
//   * /api/dashboard/me              — user-scoped (returns user info). N/A.
//   * /api/dashboard/runs/:runId/upload-session — REQUIRES active membership
//     when run.organization_id is set. Wired in Phase 5.8.
//   * /api/dashboard/runs/:runId/artifact       — REQUIRES active membership
//     when run.organization_id is set. Wired in Phase 5.8.
//
// New API-key-authenticated routes touching org-scoped data must add the
// same active-membership check; Phase 5.8 left no shared helper because
// the org context is route-specific (run, billing, etc).
//
// ----------------------------------------------------------------------------
// v7.1 — JWT-authenticated ingest API extension.
//
// Symmetric to the API-key invariant above: every ingest endpoint that
// operates on an org-scoped run MUST call `assertActiveMembership(claims)`
// after `verifyUploadToken()`. In practice this is enforced via the
// `verifyTokenAndAssertRunMembership()` orchestrator in
// `lib/upload/auth.ts` — routes call THAT, not the bare verifier.
// ESLint `no-restricted-imports` (apps/web/.eslintrc.json) blocks direct
// `verifyUploadToken` imports under `app/api/runs/**` as defense in depth.
//
// Caller audit (ingest):
//   * POST /api/upload-session                 — mint endpoint. Calls
//     `checkMembershipStatus` directly pre-mint (no JWT yet) and embeds
//     `mint_status` in the JWT for observability.
//   * PUT  /api/runs/:runId/events/:seq        — JWT-auth. MUST call
//     `verifyTokenAndAssertRunMembership()` before claim_chunk_slot.
//   * POST /api/runs/:runId/finalize           — JWT-auth. MUST call
//     `verifyTokenAndAssertRunMembership()` before manifest write.
//
// Future ingest endpoints touching org-scoped runs: same rule.
// ============================================================================

export interface ApiKeyAuth { userId: string; keyId: string }

export class AuthHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthHelperError';
  }
}

const KEY_RE = /^clp_[0-9a-f]{64}$/;

/**
 * Centralized helper for API-key auth on dashboard endpoints.
 *
 * Looks up a key by deterministic SHA256 hash (eq + maybeSingle, O(1)),
 * filters out revoked keys, and fires a non-blocking last_used_at touch.
 *
 * Returns null when the request is unauthenticated (missing header,
 * malformed key, unknown hash, revoked). Routes turn null into 401.
 *
 * Throws AuthHelperError for unexpected DB errors so routes can return
 * 500/503 instead of misreporting an outage as 401 (codex PR WARNING).
 */
export async function authViaApiKey(req: Request): Promise<ApiKeyAuth | null> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer clp_')) return null;
  const raw = auth.slice('Bearer '.length).trim();
  if (!KEY_RE.test(raw)) return null;
  const hashHex = createHash('sha256').update(raw).digest('hex');

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from('api_keys')
    .select('id, user_id')
    .eq('key_hash', hashHex)
    .is('revoked_at', null)
    .maybeSingle();

  // Distinguish DB outage from "not found" — maybeSingle returns
  // { data: null, error: null } on no rows, and { data: null, error: ... }
  // on actual DB problems.
  if (error) {
    throw new AuthHelperError(`api-key auth lookup failed: ${error.message}`);
  }
  if (!data) return null;
  const row = data as { id: string; user_id: string };

  // Fire-and-forget last_used_at touch.
  void supabase.from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(() => {}, () => {});

  return { userId: row.user_id, keyId: row.id };
}
