// GET /api/dashboard/orgs/:orgId/audit — Phase 5.2.
//
// Calls list_audit_events RPC. Cursor decode + period parsing happen
// route-side; RPC accepts typed nullable params only.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import { decodeCursor, encodeCursor } from '@/lib/dashboard/audit-cursor';

interface RouteParams { params: Promise<{ orgId: string }> | { orgId: string } }

const NO_STORE = { 'cache-control': 'private, no-store' } as const;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  const p = await Promise.resolve(params) as { orgId: string };
  if (!isValidUuid(p.orgId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422, headers: NO_STORE });
  }

  const url = new URL(req.url);
  const cursorParam = url.searchParams.get('cursor');
  const cursor = decodeCursor(cursorParam);
  if (cursor === 'invalid') {
    return NextResponse.json({ error: 'bad_cursor' }, { status: 422, headers: NO_STORE });
  }

  const limitParam = url.searchParams.get('limit');
  const limit = limitParam == null ? 50 : Number.parseInt(limitParam, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422, headers: NO_STORE });
  }

  const action = url.searchParams.get('action');
  const actorIdParam = url.searchParams.get('actorId');
  if (actorIdParam && !isValidUuid(actorIdParam)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422, headers: NO_STORE });
  }

  const sinceParam = url.searchParams.get('since');
  const untilParam = url.searchParams.get('until');
  if ((sinceParam && !ISO_RE.test(sinceParam)) || (untilParam && !ISO_RE.test(untilParam))) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422, headers: NO_STORE });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE });
  }

  const { data, error } = await createServiceRoleClient().rpc('list_audit_events', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
    p_cursor_occurred_at: cursor?.occurredAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: limit,
    p_action: action ?? null,
    p_actor_user_id: actorIdParam ?? null,
    p_since: sinceParam ?? null,
    p_until: untilParam ?? null,
  });
  if (error) {
    if (error.code === 'P0001' && error.message === 'not_admin') {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
    }
    const mapped = mapPostgresError(error);
    return NextResponse.json(mapped.body, { status: mapped.status, headers: NO_STORE });
  }

  const result = data as { events: unknown[]; nextCursor: { occurredAt: string; id: number } | null };
  const nextCursor = result.nextCursor ? encodeCursor(result.nextCursor) : null;
  return NextResponse.json({ events: result.events, nextCursor }, { status: 200, headers: NO_STORE });
}
