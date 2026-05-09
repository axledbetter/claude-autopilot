// POST /api/dashboard/orgs/:orgId/members/:userId/enable — Phase 5.7.
//
// Re-activates a previously disabled member. Symmetric owner protection
// (only owners can re-enable owners) per codex pass-2 WARNING #3.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';

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

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc('enable_member', {
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
