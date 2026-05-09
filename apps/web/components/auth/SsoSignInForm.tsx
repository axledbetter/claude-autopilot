'use client';

import { useState } from 'react';

export default function SsoSignInForm({ initialEmail }: { initialEmail: string }): React.ReactElement {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/sso/start', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await r.json().catch(() => ({})) as { authorizationUrl?: string; error?: string };
      if (!r.ok || !body.authorizationUrl) {
        setError(
          r.status === 404
            ? "We couldn't find an SSO connection for that email."
            : body.error ?? `Sign-in failed (${r.status})`,
        );
        return;
      }
      window.location.assign(body.authorizationUrl);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs opacity-70">
        Work email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          className="bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          data-testid="sso-email-input"
        />
      </label>
      {error && (
        <div className="text-xs text-red-400" data-testid="sso-signin-error">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={busy || !email}
        className="bg-white/10 hover:bg-white/15 disabled:opacity-40 px-3 py-2 rounded text-sm"
        data-testid="sso-submit-button"
      >
        {busy ? 'Redirecting…' : 'Continue with SSO'}
      </button>
    </form>
  );
}
