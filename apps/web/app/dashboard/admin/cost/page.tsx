// /dashboard/admin/cost — Phase 5.2.
// Server Component. Calls org_cost_report RPC for initial state.

import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { parsePeriod } from '@/lib/dashboard/period';
import CostTable, { type CostRow, type CostTotal } from '@/components/admin/CostTable';

export const dynamic = 'force-dynamic';

interface SearchParams { orgId?: string; since?: string; until?: string }

export default async function CostPage(
  { searchParams }: { searchParams: Promise<SearchParams> },
): Promise<React.ReactElement> {
  const params = await searchParams;
  const { orgId, since, until } = params;
  if (!orgId) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const svc = createServiceRoleClient();
  const { data: callerRow } = await svc.from('memberships')
    .select('role')
    .eq('organization_id', orgId)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();
  const callerRole = (callerRow as { role: string } | null)?.role;
  if (!callerRole || !['admin', 'owner'].includes(callerRole)) notFound();

  const period = parsePeriod(since ?? null, until ?? null);
  if (!period) notFound();

  const { data } = await svc.rpc('org_cost_report', {
    p_caller_user_id: user.id,
    p_org_id: orgId,
    p_since: period.sinceTs.toISOString(),
    p_until: period.untilTs.toISOString(),
    p_group_by: 'user',
  });
  const result = (data as { rows: CostRow[]; total: CostTotal } | null) ?? { rows: [], total: { run_count: 0, cost_usd_sum: 0, duration_ms_sum: 0, total_bytes_sum: 0 } };

  return (
    <CostTable
      orgId={orgId}
      since={period.since}
      until={period.until}
      rows={result.rows}
      total={result.total}
    />
  );
}
