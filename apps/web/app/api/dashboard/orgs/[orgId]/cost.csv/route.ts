// GET /api/dashboard/orgs/:orgId/cost.csv — Phase 5.2 CSV export.

import { createServiceRoleClient } from '@/lib/supabase/service';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import { parsePeriod } from '@/lib/dashboard/period';
import { encodeCostCsv, buildCsvFilename, type CostRow } from '@/lib/dashboard/cost-csv';

interface RouteParams { params: Promise<{ orgId: string }> | { orgId: string } }
const NO_STORE = { 'cache-control': 'private, no-store' } as const;

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  const p = await Promise.resolve(params) as { orgId: string };
  if (!isValidUuid(p.orgId)) {
    return Response.json({ error: 'malformed_params' }, { status: 422, headers: NO_STORE });
  }
  const url = new URL(req.url);
  const period = parsePeriod(url.searchParams.get('since'), url.searchParams.get('until'));
  if (!period) {
    return Response.json({ error: 'bad_period' }, { status: 422, headers: NO_STORE });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return Response.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE });

  const { data, error } = await createServiceRoleClient().rpc('org_cost_report', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
    p_since: period.sinceTs.toISOString(),
    p_until: period.untilTs.toISOString(),
    p_group_by: 'user',
  });
  if (error) {
    if (error.code === 'P0001' && error.message === 'not_admin') {
      return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
    }
    const mapped = mapPostgresError(error);
    return Response.json(mapped.body, { status: mapped.status, headers: NO_STORE });
  }

  const rows = (data as { rows: CostRow[] }).rows;
  const csv = encodeCostCsv(rows);
  const filename = buildCsvFilename(p.orgId, period.since, period.until);
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  });
}
