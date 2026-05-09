'use client';

// SSO setup card — Phase 5.4. Owner-only client component.
//
// Renders current SSO state + a button to launch the WorkOS Admin Portal.
// On click → POST /api/dashboard/orgs/:orgId/sso/setup → opens portal URL
// in new tab (rel="noopener noreferrer").
//
// Disconnect button → DELETE /api/dashboard/orgs/:orgId/sso. Confirms
// first.

import { useState } from 'react';

type Status = 'inactive' | 'pending' | 'active' | 'disabled';

interface Props {
  orgId: string;
  initialStatus: Status;
  workosOrganizationId: string | null;
  workosConnectionId: string | null;
  connectedAt: string | null;
  disabledAt: string | null;
}

const STATUS_LABEL: Record<Status, string> = {
  inactive: 'Not configured',
  pending: 'Pending — finish in Admin Portal',
  active: 'Active',
  disabled: 'Disabled',
};

export default function SsoSetupCard(props: Props): React.ReactElement {
  const [status, setStatus] = useState<Status>(props.initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startSetup(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/dashboard/orgs/${props.orgId}/sso/setup`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      });
      const body = await r.json().catch(() => ({})) as { portalUrl?: string; error?: string };
      if (!r.ok || !body.portalUrl) {
        setError(body.error ?? `setup failed (${r.status})`);
        return;
      }
      // Status flips to pending until webhook fires.
      if (status === 'inactive' || status === 'disabled') setStatus('pending');
      window.open(body.portalUrl, '_blank', 'noopener,noreferrer');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    if (!confirm('Disconnect SSO? Users will fall back to email sign-in.')) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/dashboard/orgs/${props.orgId}/sso`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const body = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) {
        setError(body.error ?? `disconnect failed (${r.status})`);
        return;
      }
      setStatus('disabled');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <h1 className="text-2xl font-bold">Single sign-on (SSO)</h1>
      <p className="text-sm opacity-70">
        Connect your identity provider (Okta, Azure AD, Google Workspace, etc.) so members
        sign in with their company credentials.
      </p>

      <div className="border border-white/10 rounded p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs opacity-60">Status</div>
            <div className="text-sm font-medium" data-testid="sso-status">
              {STATUS_LABEL[status]}
            </div>
          </div>
          {status === 'active' && props.connectedAt && (
            <div className="text-xs opacity-60">
              Connected {new Date(props.connectedAt).toLocaleDateString()}
            </div>
          )}
          {status === 'disabled' && props.disabledAt && (
            <div className="text-xs opacity-60">
              Disabled {new Date(props.disabledAt).toLocaleDateString()}
            </div>
          )}
        </div>

        {props.workosOrganizationId && (
          <div className="text-xs opacity-50 font-mono break-all">
            WorkOS org: {props.workosOrganizationId}
          </div>
        )}

        {error && (
          <div className="text-xs text-red-400" data-testid="sso-error">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={startSetup}
            disabled={busy}
            className="bg-white/10 hover:bg-white/15 disabled:opacity-40 px-3 py-1 rounded text-sm"
            data-testid="sso-setup-button"
          >
            {status === 'active' ? 'Reconfigure in Admin Portal' : 'Open Admin Portal'}
          </button>
          {(status === 'active' || status === 'pending') && (
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="bg-red-500/10 hover:bg-red-500/20 text-red-300 disabled:opacity-40 px-3 py-1 rounded text-sm"
              data-testid="sso-disconnect-button"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
