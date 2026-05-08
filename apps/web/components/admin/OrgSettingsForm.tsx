'use client';

// Org settings form — Phase 5.1. Owner-only edit of org name.

import { useState } from 'react';

interface Props { orgId: string; initialName: string }

export default function OrgSettingsForm({ orgId, initialName }: Props): React.ReactElement {
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setStatus('idle');
    setError(null);
    try {
      const r = await fetch(`/api/dashboard/orgs/${orgId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        setStatus('error');
        setError(body.error ?? `save failed (${r.status})`);
        return;
      }
      setStatus('saved');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4 max-w-xl">
      <h1 className="text-2xl font-bold">Organization settings</h1>
      <label className="flex flex-col gap-1 text-xs opacity-70">
        Name
        <input
          type="text"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="bg-black/30 border border-white/10 rounded px-3 py-1 text-sm"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting || !name.trim() || name === initialName}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-4 py-1 rounded text-sm"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' && <span className="text-xs text-green-400">Saved.</span>}
        {status === 'error' && error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </form>
  );
}
