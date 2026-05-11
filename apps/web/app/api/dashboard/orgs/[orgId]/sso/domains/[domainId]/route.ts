// DELETE /api/dashboard/orgs/:orgId/sso/domains/:domainId — Phase 5.6.
//
// Admin-gated revoke. Soft-disable; ever_verified preserved (codex spec
// pass-1 CRITICAL #1 — once verified, the domain stays bound to this
// org even after revocation, blocking takeover by another org).

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import {
  assertActiveMembershipForOrg,
  respondToMembershipError,
} from '@/lib/dashboard/assert-active-membership-for-org';

interface RouteParams { params: Promise<{ orgId: string; domainId: string }> | { orgId: string; domainId: string } }

export const runtime = 'nodejs';

export async function DELETE(req: Request, { params }: RouteParams): Promise<Response> {
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
  const { data, error } = await supabase.rpc('revoke_domain_claim', {
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
