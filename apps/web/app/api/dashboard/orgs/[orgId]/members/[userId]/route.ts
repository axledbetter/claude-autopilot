// PATCH + DELETE /api/dashboard/orgs/:orgId/members/:userId — Phase 5.1.
//
// PATCH: change role via change_member_role RPC.
// DELETE: soft-remove via remove_member RPC.
//
// Both use assertSameOrigin → resolve caller → svc.rpc → mapPostgresError.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId } from '@/lib/dashboard/membership-guard';

interface RouteParams { params: Promise<{ orgId: string; userId: string }> | { orgId: string; userId: string } }
interface PatchBody { role: string }

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { orgId: string; userId: string };
  let body: PatchBody;
  try { body = await req.json() as PatchBody; } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 422 }); }
  if (!body || typeof body.role !== 'string') {
    return NextResponse.json({ error: 'malformed_body' }, { status: 422 });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

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
  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

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
