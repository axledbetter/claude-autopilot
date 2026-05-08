'use client';

// Invite member form — Phase 5.1.

import { useState } from 'react';

interface Props {
  orgId: string;
  callerRole: 'admin' | 'owner';
  onInvited: () => Promise<void> | void;
}

export default function InviteMemberForm({ orgId, callerRole: _callerRole, onInvited }: Props): React.ReactElement {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/dashboard/orgs/${orgId}/members/invite`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? `invite failed (${r.status})`);
        return;
      }
      setEmail('');
      await onInvited();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex gap-2 items-end">
      <label className="flex flex-col flex-1 gap-1 text-xs opacity-70">
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="bg-black/30 border border-white/10 rounded px-3 py-1 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs opacity-70">
        Role
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
          className="bg-black/30 border border-white/10 rounded px-3 py-1 text-sm"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={submitting || !email}
        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-4 py-1 rounded text-sm"
      >
        {submitting ? 'Inviting…' : 'Invite'}
      </button>
      {error && <span className="text-red-400 text-xs">{error}</span>}
    </form>
  );
}
