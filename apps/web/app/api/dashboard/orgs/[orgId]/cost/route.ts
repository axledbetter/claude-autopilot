// GET /api/dashboard/orgs/:orgId/cost — Phase 5.2 cost report (JSON).

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import { parsePeriod } from '@/lib/dashboard/period';
import {
  assertActiveMembershipForOrg,
  respondToMembershipError,
} from '@/lib/dashboard/assert-active-membership-for-org';

interface RouteParams { params: Promise<{ orgId: string }> | { orgId: string } }
const NO_STORE = { 'cache-control': 'private, no-store' } as const;

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  const p = await Promise.resolve(params) as { orgId: string };
  if (!isValidUuid(p.orgId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422, headers: NO_STORE });
  }
  const url = new URL(req.url);
  const period = parsePeriod(url.searchParams.get('since'), url.searchParams.get('until'));
  if (!period) {
    return NextResponse.json({ error: 'bad_period' }, { status: 422, headers: NO_STORE });
  }
  const groupBy = url.searchParams.get('groupBy') ?? 'user';
  // Codex PR-pass WARNING — route-side validation; RPC enforces too.
  if (groupBy !== 'user') {
    return NextResponse.json({ error: 'bad_group_by' }, { status: 422, headers: NO_STORE });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE });
  }

  // v7.5.0 CRITICAL #3 — defense-in-depth membership gate.
  try {
    await assertActiveMembershipForOrg({ orgId: p.orgId, userId: callerUserId });
  } catch (err) {
    const r = respondToMembershipError(err);
    if (r) return r;
    throw err;
  }

  const { data, error } = await createServiceRoleClient().rpc('org_cost_report', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
    p_since: period.sinceTs.toISOString(),
    p_until: period.untilTs.toISOString(),
    p_group_by: groupBy,
  });
  if (error) {
    if (error.code === 'P0001' && error.message === 'not_admin') {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
    }
    const mapped = mapPostgresError(error);
    return NextResponse.json(mapped.body, { status: mapped.status, headers: NO_STORE });
  }

  // Codex plan-pass WARNING — normalize period in route response.
  const result = data as { rows: unknown[]; total: unknown; period: { since: string; until: string } };
  const normalized = {
    rows: result.rows,
    total: result.total,
    period: {
      since: period.since,
      until: period.until,
      sinceTs: period.sinceTs.toISOString(),
      untilTs: period.untilTs.toISOString(),
    },
  };
  return NextResponse.json(normalized, { status: 200, headers: NO_STORE });
}
