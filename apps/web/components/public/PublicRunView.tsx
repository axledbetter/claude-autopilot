// Public run view — Phase 4. Read-only view rendered on the public
// share-by-URL route. Includes events replay (manifest-driven, lazy
// chunks) — same EventReplay component the dashboard uses, since the
// artifact route allows anon access for visibility='public'.

import EventReplay from '@/components/dashboard/EventReplay';

export interface PublicRunRow {
  id: string;
  source_verified: boolean | null;
  events_chain_root: string | null;
  total_bytes: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  run_status: string | null;
  created_at: string;
  visibility: string | null;
}

export default function PublicRunView({ run }: { run: PublicRunRow }): React.ReactElement {
  return (
    <main className="min-h-screen p-8 max-w-5xl mx-auto flex flex-col gap-6">
      <header className="flex flex-col gap-2 border-b border-white/10 pb-4">
        <div className="flex justify-between items-baseline">
          <h1 className="text-2xl font-bold">Public run</h1>
          <span className={`text-xs px-2 py-1 rounded ${run.source_verified ? 'bg-green-500/20 text-green-300' : 'bg-amber-500/20 text-amber-300'}`}>
            {run.source_verified ? 'verified' : 'unverified'}
          </span>
        </div>
        <div className="flex gap-3 text-xs opacity-70">
          <span>{new Date(run.created_at).toLocaleString()}</span>
          <span>·</span>
          <code>{run.id.slice(0, 12)}…</code>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Status" value={run.run_status ?? '—'} />
        <Stat label="Cost" value={run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : '—'} />
        <Stat label="Duration" value={run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : '—'} />
      </div>

      <div>
        <h2 className="text-sm font-semibold opacity-70 mb-2">Chain root (tamper-evidence)</h2>
        <code className="text-xs opacity-80 break-all">{run.events_chain_root ?? '(not finalized)'}</code>
      </div>

      <div>
        <h2 className="text-sm font-semibold opacity-70 mb-2">Events</h2>
        <EventReplay runId={run.id} />
      </div>

      <footer className="text-xs opacity-50 mt-8 border-t border-white/10 pt-4">
        Hosted by claude-autopilot. The chain root above lets anyone re-verify
        the events sequence end-to-end.
      </footer>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="border border-white/10 rounded p-3 bg-black/20">
      <div className="text-xs opacity-60 mb-1">{label}</div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}
