'use client';

import { useState } from 'react';

type Status = 'pending' | 'verified' | 'revoked';

export interface DomainClaim {
  id: string;
  domain: string;
  status: Status;
  challengeRecordName?: string;
  challengeRecordValue?: string;
}

interface Props {
  orgId: string;
  initialClaims: DomainClaim[];
}

export default function SsoDomainsCard({ orgId, initialClaims }: Props): React.ReactElement {
  const [claims, setClaims] = useState<DomainClaim[]>(initialClaims);
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addDomain(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/dashboard/orgs/${orgId}/sso/domains`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      const body = await r.json().catch(() => ({})) as DomainClaim & { error?: string };
      if (!r.ok) {
        setError(body.error ?? `add failed (${r.status})`);
        return;
      }
      setClaims((prev) => [...prev, body]);
      setDomain('');
    } finally {
      setBusy(false);
    }
  }

  async function verify(claim: DomainClaim): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/dashboard/orgs/${orgId}/sso/domains/${claim.id}/verify`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await r.json().catch(() => ({})) as { error?: string; reason?: string };
      if (!r.ok) {
        setError(body.error === 'verification_failed' ? `Could not verify TXT record (${body.reason})` : body.error ?? `verify failed (${r.status})`);
        return;
      }
      setClaims((prev) => prev.map((c) => (c.id === claim.id ? { ...c, status: 'verified' } : c)));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(claim: DomainClaim): Promise<void> {
    if (!confirm(`Revoke claim for ${claim.domain}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/dashboard/orgs/${orgId}/sso/domains/${claim.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const body = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) {
        setError(body.error ?? `revoke failed (${r.status})`);
        return;
      }
      setClaims((prev) => prev.map((c) => (c.id === claim.id ? { ...c, status: 'revoked' } : c)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-white/10 rounded p-4 flex flex-col gap-4" data-testid="sso-domains-card">
      <h2 className="text-sm font-medium">Verified domains</h2>
      <p className="text-xs opacity-60">
        Add domains your members&apos; emails belong to. After adding, create a DNS TXT record to verify ownership.
      </p>

      {claims.length === 0 ? (
        <p className="text-xs opacity-50">No domains added yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {claims.map((c) => (
            <li key={c.id} className="border border-white/10 rounded p-3 flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-mono">{c.domain}</span>
                <span className="text-xs opacity-60">{c.status}</span>
              </div>
              {c.status === 'pending' && c.challengeRecordName && c.challengeRecordValue && (
                <div className="text-xs opacity-70 flex flex-col gap-1">
                  <div>Add TXT record:</div>
                  <code className="bg-black/30 rounded px-2 py-1 break-all">{c.challengeRecordName}</code>
                  <code className="bg-black/30 rounded px-2 py-1 break-all">{c.challengeRecordValue}</code>
                </div>
              )}
              <div className="flex gap-2">
                {c.status === 'pending' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => verify(c)}
                    className="bg-white/10 hover:bg-white/15 disabled:opacity-40 px-2 py-1 rounded text-xs"
                  >
                    Verify
                  </button>
                )}
                {(c.status === 'pending' || c.status === 'verified') && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => revoke(c)}
                    className="bg-red-500/10 hover:bg-red-500/20 text-red-300 disabled:opacity-40 px-2 py-1 rounded text-xs"
                  >
                    Revoke
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={addDomain} className="flex gap-2 items-end">
        <label className="flex-1 flex flex-col gap-1 text-xs opacity-70">
          Domain
          <input
            type="text"
            required
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="acme.com"
            className="bg-black/30 border border-white/10 rounded px-3 py-1 text-sm"
            data-testid="sso-domain-input"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !domain}
          className="bg-white/10 hover:bg-white/15 disabled:opacity-40 px-3 py-1 rounded text-sm"
          data-testid="sso-domain-add-button"
        >
          Add
        </button>
      </form>

      {error && (
        <div className="text-xs text-red-400" data-testid="sso-domains-error">
          {error}
        </div>
      )}
    </div>
  );
}
