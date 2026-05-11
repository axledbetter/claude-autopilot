// POST /api/dashboard/orgs/:orgId/members/:userId/disable — Phase 5.7.
//
// Admin/owner-gated lockout. RPC handles state-transition matrix +
// owner protection + last-owner guard + refresh-token revocation +
// audit. See data/deltas/20260509140000_phase5_7_lifecycle.sql.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import {
  assertActiveMembershipForOrg,
  respondToMembershipError,
} from '@/lib/dashboard/assert-active-membership-for-org';

interface RouteParams { params: Promise<{ orgId: string; userId: string }> | { orgId: string; userId: string } }

export const runtime = 'nodejs';

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { orgId: string; userId: string };
  if (!isValidUuid(p.orgId) || !isValidUuid(p.userId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422 });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // v7.5.0 CRITICAL #3 — defense-in-depth membership gate. Middleware
  // is the outer optimization (skips cookie cache for high-sensitivity
  // routes); this is the inner correctness boundary.
  try {
    await assertActiveMembershipForOrg({ orgId: p.orgId, userId: callerUserId });
  } catch (err) {
    const r = respondToMembershipError(err);
    if (r) return r;
    throw err;
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc('disable_member', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
    p_target_user_id: p.userId,
  });
  if (error) {
    const mapped = mapPostgresError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  return NextResponse.json(data, { status: 200 });
}
