// Run list item — Phase 4 server component. Renders one row in the runs
// list. Cost / duration / status are display-only — labeled "Reported by
// CLI" elsewhere; this component just shows the values or "—" for null.

import Link from 'next/link';

export interface RunListRow {
  id: string;
  created_at: string;
  source_verified: boolean | null;
  cost_usd: number | null;
  duration_ms: number | null;
  run_status: string | null;
  total_bytes: number | null;
  visibility: string | null;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function RunListItem({ run }: { run: RunListRow }): React.ReactElement {
  return (
    <Link
      href={`/dashboard/runs/${run.id}`}
      className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 items-center px-4 py-3 border-b border-white/5 hover:bg-white/5"
    >
      <div className="flex flex-col">
        <code className="text-xs opacity-80">{run.id.slice(0, 8)}…</code>
        <span className="text-xs opacity-50">{new Date(run.created_at).toLocaleString()}</span>
      </div>
      <span className={`text-xs px-2 py-1 rounded ${run.run_status === 'completed' ? 'bg-green-500/20 text-green-300' : run.run_status === 'failed' ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300'}`}>
        {run.run_status ?? '—'}
      </span>
      <span className="text-xs opacity-70 tabular-nums">{run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : '—'}</span>
      <span className="text-xs opacity-70 tabular-nums">{fmtDuration(run.duration_ms)}</span>
      <span className="text-xs opacity-50 tabular-nums">{fmtBytes(run.total_bytes)}</span>
    </Link>
  );
}
