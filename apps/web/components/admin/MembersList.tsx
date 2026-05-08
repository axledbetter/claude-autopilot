'use client';

// Members list — Phase 5.1 client component.
//
// Renders the members table with role dropdown and remove button per row.
// Embeds <InviteMemberForm> at the top. Talks directly to the API; the
// server component passes initial state to avoid a render-after-fetch flash.

import { useState } from 'react';
import InviteMemberForm from './InviteMemberForm';
import RoleSelector from './RoleSelector';

export interface MemberRow {
  id: string;
  userId: string;
  email: string | null;
  role: 'member' | 'admin' | 'owner';
  status: string;
  joinedAt: string;
}

interface Props {
  orgId: string;
  callerUserId: string;
  callerRole: 'admin' | 'owner';
  initialMembers: MemberRow[];
}

export default function MembersList({ orgId, callerUserId, callerRole, initialMembers }: Props): React.ReactElement {
  const [members, setMembers] = useState<MemberRow[]>(initialMembers);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const r = await fetch(`/api/dashboard/orgs/${orgId}/members`, { credentials: 'include' });
    if (!r.ok) return;
    const body = await r.json() as { members: MemberRow[] };
    setMembers(body.members);
  }

  async function changeRole(userId: string, role: MemberRow['role']): Promise<void> {
    setError(null);
    const r = await fetch(`/api/dashboard/orgs/${orgId}/members/${userId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      setError(body.error ?? `update failed (${r.status})`);
      return;
    }
    await refresh();
  }

  async function remove(userId: string): Promise<void> {
    setError(null);
    const r = await fetch(`/api/dashboard/orgs/${orgId}/members/${userId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      setError(body.error ?? `remove failed (${r.status})`);
      return;
    }
    await refresh();
  }

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <h1 className="text-2xl font-bold">Members</h1>
      <InviteMemberForm orgId={orgId} callerRole={callerRole} onInvited={refresh} />
      {error && <div className="text-sm text-red-400">Error: {error}</div>}
      <div className="border border-white/10 rounded">
        <div className="grid grid-cols-[2fr_1fr_1fr_auto] gap-4 px-4 py-2 border-b border-white/10 text-xs opacity-50 uppercase">
          <span>Email</span><span>Role</span><span>Joined</span><span>Actions</span>
        </div>
        {members.length === 0 ? (
          <div className="p-6 text-center opacity-60 text-sm">No active members.</div>
        ) : members.map((m) => (
          <div key={m.id} className="grid grid-cols-[2fr_1fr_1fr_auto] gap-4 px-4 py-2 border-b border-white/5 items-center text-sm">
            <span>{m.email ?? <code className="opacity-60">{m.userId.slice(0, 8)}…</code>}</span>
            <RoleSelector
              callerRole={callerRole}
              targetRole={m.role}
              isSelf={m.userId === callerUserId}
              onChange={(role) => { void changeRole(m.userId, role); }}
            />
            <span className="opacity-60 text-xs">{new Date(m.joinedAt).toLocaleDateString()}</span>
            <button
              type="button"
              onClick={() => { void remove(m.userId); }}
              disabled={m.role !== 'member' && callerRole === 'admin'}
              className="text-xs underline opacity-70 hover:opacity-100 disabled:opacity-30 disabled:no-underline"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
