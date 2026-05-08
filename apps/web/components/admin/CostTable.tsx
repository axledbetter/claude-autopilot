'use client';

// Cost table + period picker + CSV download — Phase 5.2.

import CostPeriodPicker from './CostPeriodPicker';

export interface CostRow {
  user_id: string;
  email: string | null;
  run_count: number;
  cost_usd_sum: number;
  duration_ms_sum: number;
  total_bytes_sum: number;
  last_run_at: string | null;
}

export interface CostTotal {
  run_count: number;
  cost_usd_sum: number;
  duration_ms_sum: number;
  total_bytes_sum: number;
}

interface Props {
  orgId: string;
  since: string;
  until: string;
  rows: CostRow[];
  total: CostTotal;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function CostTable({ orgId, since, until, rows, total }: Props): React.ReactElement {
  const csvHref = `/api/dashboard/orgs/${orgId}/cost.csv?since=${since}&until=${until}`;

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <div className="flex justify-between items-baseline">
        <h1 className="text-2xl font-bold">Cost report</h1>
        <a
          href={csvHref}
          download
          className="text-sm underline opacity-80 hover:opacity-100"
        >
          Download CSV
        </a>
      </div>

      <CostPeriodPicker orgId={orgId} since={since} until={until} />

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Total cost" value={`$${total.cost_usd_sum.toFixed(2)}`} />
        <Stat label="Runs" value={String(total.run_count)} />
        <Stat label="Storage" value={formatBytes(total.total_bytes_sum)} />
      </div>

      <div className="border border-white/10 rounded">
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 px-4 py-2 border-b border-white/10 text-xs opacity-50 uppercase">
          <span>User</span><span>Runs</span><span>Cost</span><span>Storage</span><span>Last run</span>
        </div>
        {rows.length === 0 ? (
          <div className="p-6 text-center opacity-60 text-sm">No runs in this period.</div>
        ) : rows.map((r) => (
          <div key={r.user_id} className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 px-4 py-2 border-b border-white/5 text-sm">
            <span>{r.email ?? <code className="opacity-60">{r.user_id.slice(0, 8)}…</code>}</span>
            <span className="font-mono">{r.run_count}</span>
            <span className="font-mono">${r.cost_usd_sum.toFixed(2)}</span>
            <span className="font-mono text-xs">{formatBytes(r.total_bytes_sum)}</span>
            <span className="text-xs opacity-60">{r.last_run_at ? new Date(r.last_run_at).toLocaleDateString() : '—'}</span>
          </div>
        ))}
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
