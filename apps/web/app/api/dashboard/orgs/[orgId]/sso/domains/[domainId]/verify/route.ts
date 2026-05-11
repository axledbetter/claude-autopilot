// POST /api/dashboard/orgs/:orgId/sso/domains/:domainId/verify — Phase 5.6.
//
// Admin-gated DNS TXT verification. Route loads the claim, runs DNS TXT
// lookup with timeout (codex pass-2 WARNING #4), then on match calls
// mark_domain_verified RPC.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import { verifyTxtChallenge } from '@/lib/dns/verify-txt';
import {
  assertActiveMembershipForOrg,
  respondToMembershipError,
} from '@/lib/dashboard/assert-active-membership-for-org';

interface RouteParams { params: Promise<{ orgId: string; domainId: string }> | { orgId: string; domainId: string } }

export const runtime = 'nodejs';

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { orgId: string; domainId: string };
  if (!isValidUuid(p.orgId) || !isValidUuid(p.domainId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422 });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // v7.5.0 CRITICAL #3 — defense-in-depth membership gate.
  try {
    await assertActiveMembershipForOrg({ orgId: p.orgId, userId: callerUserId });
  } catch (err) {
    const r = respondToMembershipError(err);
    if (r) return r;
    throw err;
  }

  const supabase = createServiceRoleClient();

  // Defense-in-depth: route-level admin check before DNS lookup.
  const { data: caller } = await supabase
    .from('memberships')
    .select('role')
    .eq('organization_id', p.orgId)
    .eq('user_id', callerUserId)
    .eq('status', 'active')
    .maybeSingle();
  const callerRole = (caller as { role: string } | null)?.role;
  if (!callerRole || !['admin', 'owner'].includes(callerRole)) {
    return NextResponse.json({ error: 'not_admin' }, { status: 403 });
  }

  const { data: claim } = await supabase
    .from('organization_domain_claims')
    .select('id, organization_id, domain, status, challenge_token')
    .eq('id', p.domainId)
    .eq('organization_id', p.orgId)
    .maybeSingle();
  if (!claim) {
    return NextResponse.json({ error: 'domain_not_found' }, { status: 404 });
  }
  const c = claim as { id: string; organization_id: string; domain: string; status: string; challenge_token: string };

  const fqdn = `_workos-verify.${c.domain}`;
  const verify = await verifyTxtChallenge(fqdn, c.challenge_token);
  if (!verify.ok) {
    return NextResponse.json(
      { error: 'verification_failed', reason: verify.reason, fqdn },
      { status: 422 },
    );
  }

  const { data, error } = await supabase.rpc('mark_domain_verified', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
    p_domain_id: p.domainId,
  });
  if (error) {
    const mapped = mapPostgresError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  return NextResponse.json(data, { status: 200 });
}
