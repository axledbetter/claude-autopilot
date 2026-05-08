'use client';

// Role selector — Phase 5.1.
//
// Disables transitions the caller can't perform per the matrix:
//   admin: member ↔ admin (cannot select owner)
//   owner: any → any (subject to last-owner check at server)

import type { MemberRow } from './MembersList';

interface Props {
  callerRole: 'admin' | 'owner';
  targetRole: MemberRow['role'];
  isSelf: boolean;
  onChange: (newRole: MemberRow['role']) => void;
}

export default function RoleSelector({ callerRole, targetRole, isSelf: _isSelf, onChange }: Props): React.ReactElement {
  const adminCannotTouchOwner = callerRole === 'admin' && targetRole === 'owner';
  return (
    <select
      value={targetRole}
      onChange={(e) => onChange(e.target.value as MemberRow['role'])}
      disabled={adminCannotTouchOwner}
      className="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs disabled:opacity-50"
    >
      <option value="member">Member</option>
      <option value="admin">Admin</option>
      {/* Owner only selectable when caller is owner */}
      {callerRole === 'owner' && <option value="owner">Owner</option>}
      {/* If target is currently owner, keep showing the option even for admins so it doesn't disappear; the disable above prevents change */}
      {callerRole === 'admin' && targetRole === 'owner' && <option value="owner">Owner</option>}
    </select>
  );
}
