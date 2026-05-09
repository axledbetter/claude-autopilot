// DELETE /api/dashboard/orgs/:orgId/sso — Phase 5.4.
//
// Two-step disconnect (owner-only):
//   1. disable_sso_connection RPC: status='disabled', sso_disabled_at=now,
//      audit append. Returns workos_connection_id.
//   2. workos.connections.deleteConnection(connection_id). Failure here
//      is non-fatal — the org is already locally disabled; the eventual
//      connection.deleted webhook clears the connection_id row via
//      apply_workos_event.
//
// Idempotent: if the connection is already disabled, returns 200 with
// noop=true and skips the WorkOS DELETE.
//
// Cache-Control: private, no-store.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import { getWorkOS } from '@/lib/workos/client';

interface RouteParams { params: Promise<{ orgId: string }> | { orgId: string } }

export const runtime = 'nodejs';

export async function DELETE(req: Request, { params }: RouteParams): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { orgId: string };
  if (!isValidUuid(p.orgId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422 });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const supabase = createServiceRoleClient();
  const { data, error: rpcErr } = await supabase.rpc('disable_sso_connection', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
  });
  if (rpcErr) {
    const mapped = mapPostgresError(rpcErr);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  const result = data as {
    organizationId: string;
    status: string;
    workosConnectionId: string | null;
    noop: boolean;
  } | null;

  // If we transitioned, try the WorkOS DELETE. Failure non-fatal — the
  // local state is the source of truth; webhook eventually reconciles.
  let workosDeleted = true;
  let workosError: string | null = null;
  if (result && !result.noop && result.workosConnectionId) {
    try {
      const workos = getWorkOS();
      await workos.connections.deleteConnection(result.workosConnectionId);
    } catch (err) {
      workosDeleted = false;
      workosError = err instanceof Error ? err.message : 'workos_delete_failed';
    }
  }

  return NextResponse.json(
    { ...result, workosDeleted, workosError },
    { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
