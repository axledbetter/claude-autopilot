'use client';

// SSO required toggle (Phase 5.6).
//
// Codex spec pass-1 WARNING #7 + pass-2 NOTE #2 — renders even when
// sso_connection_status !== 'active' so admins can turn it OFF.
// Backend (set_sso_required) refuses turning ON unless connection is
// active. UI shows an amber banner when sso_required=true + connection
// inactive, explaining the asymmetric guard.

import { useState } from 'react';

type Status = 'inactive' | 'pending' | 'active' | 'disabled';

interface Props {
  orgId: string;
  initialSsoRequired: boolean;
  ssoConnectionStatus: Status;
}

export default function SsoRequiredToggle({
  orgId,
  initialSsoRequired,
  ssoConnectionStatus,
}: Props): React.ReactElement {
  const [ssoRequired, setSsoRequired] = useState(initialSsoRequired);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/dashboard/orgs/${orgId}/sso/required`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ssoRequired: next }),
      });
      const body = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) {
        setError(body.error === 'no_active_sso'
          ? 'You can\'t require SSO until the SSO connection is active. Reconnect SSO above first.'
          : body.error ?? `save failed (${r.status})`);
        return;
      }
      setSsoRequired(next);
    } finally {
      setBusy(false);
    }
  }

  const showInactiveBanner = ssoRequired && ssoConnectionStatus !== 'active';

  return (
    <div className="border border-white/10 rounded p-4 flex flex-col gap-3" data-testid="sso-required-toggle">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Require SSO</div>
          <div className="text-xs opacity-60">
            When enabled, members whose email matches a verified domain must sign in via SSO.
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => toggle(!ssoRequired)}
          className={`px-3 py-1 rounded text-sm border ${
            ssoRequired
              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
              : 'bg-white/5 border-white/10 text-white/60'
          } disabled:opacity-40`}
          data-testid="sso-required-button"
        >
          {ssoRequired ? 'Required' : 'Optional'}
        </button>
      </div>

      {showInactiveBanner && (
        <div
          className="text-xs bg-amber-500/10 text-amber-300 border border-amber-500/30 rounded p-3"
          data-testid="sso-required-inactive-banner"
        >
          <strong>SSO required is saved but not currently enforced.</strong> Your SSO connection is{' '}
          <code>{ssoConnectionStatus}</code>. Reconnect SSO via the Admin Portal above to resume enforcement, or turn this off if your team should fall back to other sign-in methods.
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400" data-testid="sso-required-error">
          {error}
        </div>
      )}
    </div>
  );
}
