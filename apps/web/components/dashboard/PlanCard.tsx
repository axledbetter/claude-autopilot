// Plan card — Phase 4 server component. Shows current plan + caps +
// usage bars. Upgrade button is delegated to a small client wrapper
// since it POSTs.

import UpgradeButtons from './UpgradeButtons';

interface Props {
  plan: 'free' | 'small' | 'mid' | string;
  organizationId: string | null;
  runsUsed: number;
  runsCap: number;
  storageUsedBytes: number;
  storageCapBytes: number;
}

function pct(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, Math.round((used / cap) * 100));
}

function fmtGB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function PlanCard(props: Props): React.ReactElement {
  const runsPct = pct(props.runsUsed, props.runsCap);
  const storagePct = pct(props.storageUsedBytes, props.storageCapBytes);

  return (
    <div className="border border-white/10 rounded p-6 flex flex-col gap-4 bg-black/20">
      <div className="flex justify-between items-baseline">
        <h2 className="text-lg font-semibold capitalize">{props.plan} plan</h2>
        {props.plan === 'free' && props.organizationId && (
          <UpgradeButtons organizationId={props.organizationId} />
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs opacity-70">
          <span>Runs this month</span>
          <span className="tabular-nums">{props.runsUsed} / {props.runsCap}</span>
        </div>
        <div className="h-2 bg-white/10 rounded">
          <div className={`h-2 rounded ${runsPct >= 90 ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${runsPct}%` }} />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs opacity-70">
          <span>Storage</span>
          <span className="tabular-nums">{fmtGB(props.storageUsedBytes)} / {fmtGB(props.storageCapBytes)}</span>
        </div>
        <div className="h-2 bg-white/10 rounded">
          <div className={`h-2 rounded ${storagePct >= 90 ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${storagePct}%` }} />
        </div>
      </div>
    </div>
  );
}
