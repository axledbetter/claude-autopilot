'use client';

import { useState } from 'react';

interface Props { organizationId: string }

export default function ManageSubscriptionButton({ organizationId }: Props): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/dashboard/billing/portal', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `portal failed (${res.status})`);
        setBusy(false);
        return;
      }
      const { url } = await res.json() as { url: string };
      if (typeof window !== 'undefined') window.location.assign(url);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void go()}
        disabled={busy}
        className="bg-white/10 hover:bg-white/20 text-white text-sm px-4 py-2 rounded disabled:opacity-50"
      >
        {busy ? 'Opening Stripe…' : 'Manage subscription'}
      </button>
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}
