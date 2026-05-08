'use client';

// Upgrade buttons — client wrapper for the Phase 3 checkout endpoint.

import { useState } from 'react';

interface Props { organizationId: string }

export default function UpgradeButtons({ organizationId }: Props): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function go(tier: 'small' | 'mid', interval: 'monthly' | 'yearly'): Promise<void> {
    setBusy(`${tier}-${interval}`);
    setErr(null);
    try {
      const res = await fetch('/api/dashboard/billing/checkout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, tier, interval }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `checkout failed (${res.status})`);
        setBusy(null);
        return;
      }
      const { url } = await res.json() as { url: string };
      if (typeof window !== 'undefined') window.location.assign(url);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void go('small', 'monthly')}
          disabled={!!busy}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded disabled:opacity-50"
        >
          {busy === 'small-monthly' ? '…' : 'Upgrade — Small'}
        </button>
        <button
          type="button"
          onClick={() => void go('mid', 'monthly')}
          disabled={!!busy}
          className="bg-purple-600 hover:bg-purple-500 text-white text-sm px-3 py-1.5 rounded disabled:opacity-50"
        >
          {busy === 'mid-monthly' ? '…' : 'Upgrade — Mid'}
        </button>
      </div>
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}
