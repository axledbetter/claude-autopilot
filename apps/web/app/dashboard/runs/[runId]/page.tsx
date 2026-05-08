// /dashboard/runs/[runId] — Phase 4 server component.

import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import EventReplay from '@/components/dashboard/EventReplay';
import VisibilityToggle from '@/components/dashboard/VisibilityToggle';

export const dynamic = 'force-dynamic';

interface RunDetailRow {
  id: string;
  user_id: string;
  source_verified: boolean | null;
  cost_usd: number | null;
  duration_ms: number | null;
  run_status: string | null;
  total_bytes: number | null;
  created_at: string;
  visibility: string | null;
  events_chain_root: string | null;
}

export default async function RunDetail(
  { params }: { params: Promise<{ runId: string }> },
): Promise<React.ReactElement> {
  const { runId } = await params;

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const svc = createServiceRoleClient();
  const { data: runRaw } = await svc.from('runs')
    .select('id, user_id, source_verified, cost_usd, duration_ms, run_status, total_bytes, created_at, visibility, events_chain_root')
    .eq('id', runId)
    .maybeSingle();
  const run = runRaw as RunDetailRow | null;
  if (!run) notFound();
  if (run.user_id !== user.id) notFound();   // 404 not 403 — avoid enumeration.

  const visibility = (run.visibility === 'public' ? 'public' : 'private') as 'public' | 'private';

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-xl font-bold">
            Run <code className="text-base opacity-80">{run.id.slice(0, 12)}…</code>
          </h1>
          <p className="text-xs opacity-60 mt-1">
            {new Date(run.created_at).toLocaleString()}
          </p>
        </div>
        <VisibilityToggle runId={run.id} initialVisibility={visibility} />
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Stat label="Status" value={run.run_status ?? '—'} />
        <Stat label="Cost" value={run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : '—'} hint="Reported by CLI" />
        <Stat label="Duration" value={run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : '—'} hint="Reported by CLI" />
        <Stat label="Verified" value={run.source_verified ? 'yes' : 'no'} />
      </div>

      <div>
        <h2 className="text-sm font-semibold opacity-70 mb-2">Chain root</h2>
        <code className="text-xs opacity-80 break-all">{run.events_chain_root ?? '(not finalized)'}</code>
      </div>

      <div>
        <h2 className="text-sm font-semibold opacity-70 mb-2">Events</h2>
        <EventReplay runId={run.id} />
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): React.ReactElement {
  return (
    <div className="border border-white/10 rounded p-3 bg-black/20">
      <div className="text-xs opacity-60 mb-1">
        {label}{hint && <span title={hint} className="opacity-50 ml-1">(?)</span>}
      </div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}
