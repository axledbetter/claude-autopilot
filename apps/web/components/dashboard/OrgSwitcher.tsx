'use client';

// Phase 5.3 — header org switcher.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface OrgOption {
  id: string;
  name: string;
  role: string;
}

interface Props {
  orgs: OrgOption[];
  activeOrgId: string;
}

export default function OrgSwitcher({ orgs, activeOrgId }: Props): React.ReactElement | null {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  if (orgs.length <= 1) return null;  // single-org users see nothing

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>): Promise<void> {
    const orgId = e.target.value;
    if (orgId === activeOrgId) return;
    setSubmitting(true);
    try {
      const r = await fetch('/api/dashboard/active-org', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId }),
      });
      if (!r.ok) {
        setSubmitting(false);
        return;
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <select
      value={activeOrgId}
      onChange={handleChange}
      disabled={submitting}
      className="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
      aria-label="Active organization"
    >
      {orgs.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name} {o.role !== 'member' && `(${o.role})`}
        </option>
      ))}
    </select>
  );
}
