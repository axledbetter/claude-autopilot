// Phase 5.6 — SSO-required enforcement chokepoint.
//
// Codex spec pass-2 CRITICAL #1: every non-SSO sign-in surface in
// autopilot.dev MUST run this check after minting a session, BEFORE
// returning cookies to the client. See sign-in surface registry in
// docs/specs/v7.0-phase5.6-workos-signin.md.

import { createServiceRoleClient } from '@/lib/supabase/service';
import { normalizeEmailDomain } from '@/lib/dns/normalize-domain';

export type EnforcementResult =
  | { action: 'allow' }
  | { action: 'redirect_to_sso'; email: string };

export async function enforceSsoRequired(
  email: string | null | undefined,
): Promise<EnforcementResult> {
  if (!email) return { action: 'allow' };
  const norm = normalizeEmailDomain(email);
  if (!norm.ok) return { action: 'allow' };  // malformed — let auth layer handle
  const svc = createServiceRoleClient();
  // Two queries — no FK between domain_claims and organization_settings,
  // so PostgREST embedded join would require defining one (codex pass-2
  // WARNING #7).
  const { data: claim } = await svc
    .from('organization_domain_claims')
    .select('organization_id')
    .eq('domain', norm.domain)
    .eq('status', 'verified')
    .maybeSingle();
  if (!claim) return { action: 'allow' };
  const { data: settings } = await svc
    .from('organization_settings')
    .select('sso_required, sso_connection_status')
    .eq('organization_id', (claim as { organization_id: string }).organization_id)
    .maybeSingle();
  const s = settings as { sso_required: boolean; sso_connection_status: string } | null;
  if (s?.sso_required && s?.sso_connection_status === 'active') {
    return { action: 'redirect_to_sso', email };
  }
  return { action: 'allow' };
}
