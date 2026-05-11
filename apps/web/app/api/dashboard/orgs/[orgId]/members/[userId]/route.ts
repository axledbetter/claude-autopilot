// PATCH + DELETE /api/dashboard/orgs/:orgId/members/:userId — Phase 5.1.
//
// PATCH: change role via change_member_role RPC.
// DELETE: soft-remove via remove_member RPC.
//
// Both use assertSameOrigin → resolve caller → svc.rpc → mapPostgresError.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import {
  assertActiveMembershipForOrg,
  respondToMembershipError,
} from '@/lib/dashboard/assert-active-membership-for-org';

interface RouteParams { params: Promise<{ orgId: string; userId: string }> | { orgId: string; userId: string } }
interface PatchBody { role: string }

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { orgId: string; userId: string };
  if (!isValidUuid(p.orgId) || !isValidUuid(p.userId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422 });
  }
  let body: PatchBody;
  try { body = await req.json() as PatchBody; } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 422 }); }
  if (!body || typeof body.role !== 'string') {
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

  const { data, error } = await createServiceRoleClient().rpc('change_member_role', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
    p_target_user_id: p.userId,
    p_new_role: body.role,
  });
  if (error) {
    const mapped = mapPostgresError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  return NextResponse.json(data, { status: 200 });
}

export async function DELETE(req: Request, { params }: RouteParams): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { orgId: string; userId: string };
  if (!isValidUuid(p.orgId) || !isValidUuid(p.userId)) {
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

  const { data, error } = await createServiceRoleClient().rpc('remove_member', {
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
