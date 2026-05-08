'use client';

// Cost period picker — Phase 5.2. since/until month inputs (YYYY-MM).

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  orgId: string;
  since: string;
  until: string;
}

export default function CostPeriodPicker({ orgId, since, until }: Props): React.ReactElement {
  const router = useRouter();
  const [s, setS] = useState(since);
  const [u, setU] = useState(until);

  function apply(): void {
    const params = new URLSearchParams({ orgId, since: s, until: u });
    router.push(`/dashboard/admin/cost?${params.toString()}` as never);
  }

  return (
    <div className="flex gap-3 items-end">
      <label className="flex flex-col gap-1 text-xs opacity-70">
        From
        <input
          type="month"
          value={s}
          onChange={(e) => setS(e.target.value)}
          className="bg-black/30 border border-white/10 rounded px-3 py-1 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs opacity-70">
        To
        <input
          type="month"
          value={u}
          onChange={(e) => setU(e.target.value)}
          className="bg-black/30 border border-white/10 rounded px-3 py-1 text-sm"
        />
      </label>
      <button
        type="button"
        onClick={apply}
        className="bg-blue-600 hover:bg-blue-500 px-4 py-1 rounded text-sm"
      >
        Apply
      </button>
    </div>
  );
}
