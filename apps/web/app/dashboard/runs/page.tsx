// /dashboard/runs — Phase 4 paginated run list (20/page, offset-based).

import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import RunListItem, { type RunListRow } from '@/components/dashboard/RunListItem';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface SearchParams { page?: string }

export default async function RunsList(
  { searchParams }: { searchParams: Promise<SearchParams> },
): Promise<React.ReactElement> {
  const params = await searchParams;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <div>Not signed in</div>;

  const svc = createServiceRoleClient();
  const { data: runsRaw } = await svc.from('runs')
    .select('id, created_at, source_verified, cost_usd, duration_ms, run_status, total_bytes, visibility')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  const runs = (runsRaw as RunListRow[] | null) ?? [];

  return (
    <div className="flex flex-col gap-4 max-w-5xl">
      <div className="flex justify-between items-baseline">
        <h1 className="text-2xl font-bold">Runs</h1>
        <span className="text-sm opacity-60">Page {page}</span>
      </div>

      <div className="border border-white/10 rounded">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 px-4 py-2 border-b border-white/10 text-xs opacity-50 uppercase tracking-wide">
          <span>Run</span>
          <span>Status</span>
          <span>Cost</span>
          <span>Duration</span>
          <span>Size</span>
        </div>
        {runs.length === 0 ? (
          <div className="p-6 text-center opacity-60 text-sm">No runs to show.</div>
        ) : (
          runs.map((r) => <RunListItem key={r.id} run={r} />)
        )}
      </div>

      <div className="flex justify-between text-sm">
        {page > 1 ? (
          <Link href={`/dashboard/runs?page=${page - 1}`} className="opacity-70 hover:opacity-100">
            ← Newer
          </Link>
        ) : <span />}
        {runs.length === PAGE_SIZE ? (
          <Link href={`/dashboard/runs?page=${page + 1}`} className="opacity-70 hover:opacity-100">
            Older →
          </Link>
        ) : <span />}
      </div>
    </div>
  );
}
