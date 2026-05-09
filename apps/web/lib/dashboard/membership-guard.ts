// Centralized error mapping + caller resolution for Phase 5.1 routes.
//
// Codex plan-pass WARNING: shared resolveSessionUserId avoids
// per-route duplication across 5 endpoints.
//
// All Phase 5.1 routes use:
//   - assertSameOrigin (mutating only)
//   - resolveSessionUserId (cookie-verified getUser → 401 if null)
//   - createServiceRoleClient().rpc(<phase 5.1 rpc>, args)
//   - mapPostgresError on rpc error
// The RPCs themselves are REVOKE FROM authenticated; GRANT service_role
// — see data/deltas/20260508140000_phase5_1_member_rpcs.sql.

import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export type PgError = { code?: string | null; message?: string | null };

const MAP: Record<string, number> = {
  not_admin: 403,
  not_owner: 403,
  not_member: 404,
  user_not_found: 404,
  target_not_member: 404,
  org_not_found: 404,
  already_member: 409,
  last_owner: 422,
  role_transition: 422,
  bad_role: 422,
  bad_name: 422,
  bad_email: 422,
  // Phase 5.2 additions.
  bad_group_by: 422,
  bad_period: 422,
  bad_cursor: 422,
  // Phase 5.4 — WorkOS SSO setup.
  workos_org_already_bound: 422,
  bad_workos_org_id: 422,
  webhook_signature_invalid: 401,
  // Phase 5.6 — WorkOS SSO sign-in.
  invalid_domain: 422,
  invalid_challenge_token: 422,
  domain_already_claimed: 422,
  domain_already_pending: 409,
  domain_not_found: 404,
  domain_revoked: 422,
  no_active_sso: 422,
  state_not_found: 401,
  state_expired: 401,
  state_already_consumed: 401,
  state_nonce_mismatch: 401,
  state_workos_org_mismatch: 401,
  state_workos_connection_mismatch: 401,
  email_domain_not_claimed_for_org: 403,
  unknown_org: 422,
  invalid_email: 422,
};

export function mapPostgresError(err: PgError): { status: number; body: { error: string } } {
  // 42501 = privilege denied (the REVOKE on the RPCs catches direct
  // authenticated calls). Don't leak privilege info — return internal.
  if (err.code !== 'P0001' || !err.message) {
    return { status: 500, body: { error: 'internal' } };
  }
  const status = MAP[err.message];
  if (!status) return { status: 500, body: { error: 'internal' } };
  return { status, body: { error: err.message } };
}

export async function resolveSessionUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return null;
    const ssr = createSsrServerClient(url, anon, {
      cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await ssr.auth.getUser();
    return user?.id ?? null;
  } catch { return null; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidUuid(s: string | undefined | null): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}
