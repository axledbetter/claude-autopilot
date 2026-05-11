// PATCH /api/dashboard/orgs/:orgId/sso/required — Phase 5.6.
//
// Owner-only sso_required toggle. Asymmetric guard lives in the RPC
// (codex spec pass-1 WARNING #7): turning OFF always allowed; turning
// ON requires sso_connection_status='active'.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import {
  assertActiveMembershipForOrg,
  respondToMembershipError,
} from '@/lib/dashboard/assert-active-membership-for-org';

interface RouteParams { params: Promise<{ orgId: string }> | { orgId: string } }
interface Body { ssoRequired?: unknown }

export const runtime = 'nodejs';

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { orgId: string };
  if (!isValidUuid(p.orgId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422 });
  }

  let body: Body;
  try { body = (await req.json()) as Body; } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 422 });
  }
  if (typeof body.ssoRequired !== 'boolean') {
    return NextResponse.json({ error: 'malformed_body' }, { status: 422 });
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
  const { data, error } = await supabase.rpc('set_sso_required', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
    p_required: body.ssoRequired,
  });
  if (error) {
    const mapped = mapPostgresError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  return NextResponse.json(data, { status: 200 });
}
