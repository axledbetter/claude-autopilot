// PATCH /api/dashboard/orgs/:orgId — Phase 5.1.
//
// Owner-only org metadata update via update_org_name RPC.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';

interface RouteParams { params: Promise<{ orgId: string }> | { orgId: string } }
interface Body { name: string }

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { orgId: string };
  if (!isValidUuid(p.orgId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422 });
  }
  let body: Body;
  try { body = await req.json() as Body; } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 422 }); }
  if (!body || typeof body.name !== 'string') {
    return NextResponse.json({ error: 'malformed_body' }, { status: 422 });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { data, error } = await createServiceRoleClient().rpc('update_org_name', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
    p_new_name: body.name,
  });
  if (error) {
    const mapped = mapPostgresError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  return NextResponse.json(data, { status: 200 });
}
