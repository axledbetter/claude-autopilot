// /dashboard overview — Phase 4 server component.
//
// Shows: run count this month, cost MTD, current plan, recent runs (5).

import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import RunListItem, { type RunListRow } from '@/components/dashboard/RunListItem';
import CostChart, { type DailyCost } from '@/components/dashboard/CostChart';
import PlanCard from '@/components/dashboard/PlanCard';

export const dynamic = 'force-dynamic';

interface MembershipRow {
  organization_id: string;
  role: string;
  status: string;
}

interface EntitlementRow {
  plan: string;
  runs_per_month_cap: number | null;
  storage_bytes_cap: number | null;
}

export default async function DashboardOverview(): Promise<React.ReactElement> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  // Layout already guards this — narrowing for TS only.
  if (!user) return <div>Not signed in</div>;

  const svc = createServiceRoleClient();

  // Resolve org context (first active membership) — Phase 4 simple model;
  // Phase 5 may add an explicit selector.
  const { data: membershipsRaw } = await svc.from('memberships')
    .select('organization_id, role, status')
    .eq('user_id', user.id)
    .eq('status', 'active');
  const memberships = (membershipsRaw as MembershipRow[] | null) ?? [];
  const organizationId: string | null = memberships[0]?.organization_id ?? null;

  // Entitlement.
  let entitlement: EntitlementRow = { plan: 'free', runs_per_month_cap: 100, storage_bytes_cap: 5 * 1024 * 1024 * 1024 };
  if (organizationId) {
    const { data } = await svc.from('entitlements')
      .select('plan, runs_per_month_cap, storage_bytes_cap')
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (data) entitlement = data as EntitlementRow;
  } else {
    const { data } = await svc.from('personal_entitlements')
      .select('plan, runs_per_month_cap, storage_bytes_cap')
      .eq('user_id', user.id)
      .maybeSingle();
    if (data) entitlement = data as EntitlementRow;
  }

  // Runs this month (UTC).
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  // Pull recent runs + monthly aggregates in one shot.
  const runFilter = svc.from('runs')
    .select('id, created_at, source_verified, cost_usd, duration_ms, run_status, total_bytes, visibility')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  const { data: runsRaw } = await runFilter;
  const runs = (runsRaw as RunListRow[] | null) ?? [];
  const monthRuns = runs.filter((r) => new Date(r.created_at) >= monthStart);
  const recentRuns = runs.slice(0, 5);
  const costMTD = monthRuns.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const storageUsed = runs.reduce((s, r) => s + (r.total_bytes ?? 0), 0);

  // Last-30-days cost chart.
  const dayMs = 86400_000;
  const since = new Date(Date.now() - 30 * dayMs);
  const dailyMap = new Map<string, number>();
  for (let i = 0; i < 30; i++) {
    const d = new Date(since.getTime() + i * dayMs);
    dailyMap.set(d.toISOString().slice(0, 10), 0);
  }
  for (const r of runs) {
    if (new Date(r.created_at) < since) continue;
    const day = r.created_at.slice(0, 10);
    if (dailyMap.has(day)) dailyMap.set(day, (dailyMap.get(day) ?? 0) + (r.cost_usd ?? 0));
  }
  const chartData: DailyCost[] = Array.from(dailyMap.entries()).map(([date, cost_usd]) => ({ date, cost_usd }));

  return (
    <div className="flex flex-col gap-8 max-w-5xl">
      <h1 className="text-2xl font-bold">Overview</h1>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Runs this month" value={String(monthRuns.length)} />
        <Stat label="Cost (MTD)" value={`$${costMTD.toFixed(2)}`} />
        <Stat label="Plan" value={entitlement.plan} />
      </div>

      <div>
        <h2 className="text-sm font-semibold opacity-70 mb-2">Cost — last 30 days <span className="opacity-60 font-normal">(reported by CLI)</span></h2>
        <CostChart data={chartData} />
      </div>

      <PlanCard
        plan={entitlement.plan}
        organizationId={organizationId}
        runsUsed={monthRuns.length}
        runsCap={entitlement.runs_per_month_cap ?? 100}
        storageUsedBytes={storageUsed}
        storageCapBytes={entitlement.storage_bytes_cap ?? 5 * 1024 * 1024 * 1024}
      />

      <div>
        <div className="flex justify-between items-baseline mb-2">
          <h2 className="text-lg font-semibold">Recent runs</h2>
          <Link href="/dashboard/runs" className="text-sm opacity-70 hover:opacity-100">
            See all →
          </Link>
        </div>
        <div className="border border-white/10 rounded">
          {recentRuns.length === 0 ? (
            <div className="p-6 text-center opacity-60 text-sm">No runs yet — upload one with <code>autopilot dashboard upload</code>.</div>
          ) : (
            recentRuns.map((r) => <RunListItem key={r.id} run={r} />)
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="border border-white/10 rounded p-4 bg-black/20">
      <div className="text-xs opacity-60 mb-1">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
