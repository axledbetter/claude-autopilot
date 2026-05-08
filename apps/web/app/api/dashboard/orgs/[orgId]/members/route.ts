// app/api/dashboard/orgs/[orgId]/members/route.ts
//
// GET /api/dashboard/orgs/:orgId/members — list active members with email lookup.
// Codex PR-pass CRITICAL — uses list_org_members_with_emails RPC instead of
// direct auth.users REST access (which isn't reliably exposed through PostgREST).

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';

interface RouteParams { params: Promise<{ orgId: string }> | { orgId: string } }

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const p = await Promise.resolve(params) as { orgId: string };
  if (!isValidUuid(p.orgId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422 });
  }
  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc('list_org_members_with_emails', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
  });
  if (error) {
    // not_member → 404 (avoids enumeration); other errors map normally.
    if (error.code === 'P0001' && error.message === 'not_member') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const mapped = mapPostgresError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  return NextResponse.json(data, { status: 200 });
}
