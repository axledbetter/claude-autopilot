'use client';

// Visibility toggle — Phase 4 client component. PATCHes
// /api/dashboard/runs/:runId/visibility (the narrow PATCH endpoint with
// owner check + Origin guard). Optimistic update.

import { useState } from 'react';

interface Props {
  runId: string;
  initialVisibility: 'public' | 'private';
}

export default function VisibilityToggle({ runId, initialVisibility }: Props): React.ReactElement {
  const [visibility, setVisibility] = useState<'public' | 'private'>(initialVisibility);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    const next = visibility === 'public' ? 'private' : 'public';
    if (next === 'public') {
      const ok = typeof window !== 'undefined'
        ? window.confirm('Make this run public? This includes the run\'s full state.json which may contain tool outputs and cost details. Anyone with the URL will be able to read it.')
        : true;
      if (!ok) return;
    }
    setBusy(true);
    setErr(null);
    // Optimistic.
    const prev = visibility;
    setVisibility(next);
    try {
      const res = await fetch(`/api/dashboard/runs/${runId}/visibility`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `update failed (${res.status})`);
        setVisibility(prev);
      }
    } catch (e) {
      setErr((e as Error).message);
      setVisibility(prev);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        className={`text-sm px-3 py-1.5 rounded border ${visibility === 'public' ? 'border-green-500/50 bg-green-500/10' : 'border-white/10 bg-white/5'} hover:bg-white/10 disabled:opacity-50`}
      >
        {visibility === 'public' ? 'Public' : 'Private'} — toggle
      </button>
      {visibility === 'public' && typeof window !== 'undefined' && (
        <code className="text-xs opacity-60 truncate max-w-[300px]">
          {window.location.origin}/runs/{runId}
        </code>
      )}
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}
