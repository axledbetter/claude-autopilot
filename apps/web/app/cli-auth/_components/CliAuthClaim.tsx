'use client';

// CLI auth claim — Phase 4 client component.
//
// Holds the minted apiKey in JS memory (state) only. Never persists to
// localStorage / cookies / etc. (out of scope on tab close).
//
// Mints via /api/dashboard/api-keys/mint, then POSTs to the loopback cb
// URL with mode: 'cors'. The Phase 2.3 listener gained CORS support in
// Phase 4 (OPTIONS preflight + Access-Control-Allow-Origin on success).
//
// Retry path: on loopback failure, keep apiKey in state — DO NOT re-mint
// (would 409 on nonce dedup). Show a Retry button.

import { useState } from 'react';

type Status =
  | 'idle'
  | 'minting'
  | 'mint-failed'
  | 'nonce-already-used'
  | 'delivering'
  | 'delivered'
  | 'loopback-failed';

interface Props { cb: string; nonce: string; accountEmail: string }

interface MintedKey { apiKey: string; fingerprint: string }

export default function CliAuthClaim({ cb, nonce, accountEmail }: Props): React.ReactElement {
  const [status, setStatus] = useState<Status>('idle');
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function mintAndDeliver(): Promise<void> {
    setStatus('minting');
    setErrMsg(null);
    try {
      const mintRes = await fetch('/api/dashboard/api-keys/mint', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, callbackUrl: cb }),
      });
      if (!mintRes.ok) {
        if (mintRes.status === 409) {
          setStatus('nonce-already-used');
          return;
        }
        const body = await mintRes.text().catch(() => '');
        setErrMsg(body || `mint failed (${mintRes.status})`);
        setStatus('mint-failed');
        return;
      }
      const data = await mintRes.json() as MintedKey;
      setMinted(data);
      await deliverToCli(data);
    } catch (err) {
      setErrMsg((err as Error).message);
      setStatus('mint-failed');
    }
  }

  async function deliverToCli(payload: MintedKey): Promise<void> {
    setStatus('delivering');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    try {
      const res = await fetch(cb, {
        method: 'POST',
        mode: 'cors',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: payload.apiKey,
          nonce,
          fingerprint: payload.fingerprint,
          accountEmail,
        }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        setErrMsg(`loopback returned ${res.status}`);
        setStatus('loopback-failed');
        return;
      }
      const body = await res.json() as { ok?: boolean; nonce?: string };
      if (body.ok !== true || body.nonce !== nonce) {
        setErrMsg('loopback returned unexpected body');
        setStatus('loopback-failed');
        return;
      }
      setStatus('delivered');
    } catch (err) {
      clearTimeout(timer);
      setErrMsg((err as Error).message);
      setStatus('loopback-failed');
    }
  }

  const retry = (): void => {
    if (minted) {
      void deliverToCli(minted);
    } else {
      void mintAndDeliver();
    }
  };

  if (status === 'delivered') {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-green-400 text-lg">CLI is now logged in.</p>
        <p className="opacity-60 text-sm">You can close this tab.</p>
      </div>
    );
  }
  if (status === 'nonce-already-used') {
    return (
      <div className="flex flex-col items-center gap-3 max-w-md text-center">
        <p className="text-amber-400">This sign-in link was already used.</p>
        <p className="opacity-60 text-sm">
          Run <code>claude-autopilot dashboard login</code> again to start a fresh session.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 max-w-md text-center">
      <p className="opacity-80">
        Signed in as <strong>{accountEmail}</strong>
      </p>
      <button
        type="button"
        onClick={() => void mintAndDeliver()}
        disabled={status === 'minting' || status === 'delivering'}
        className="bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-2 rounded disabled:opacity-50"
      >
        {status === 'idle' && 'Sign in CLI'}
        {status === 'minting' && 'Minting key…'}
        {status === 'delivering' && 'Delivering to CLI…'}
        {status === 'mint-failed' && 'Try again'}
        {status === 'loopback-failed' && 'Retry'}
      </button>
      {(status === 'mint-failed' || status === 'loopback-failed') && (
        <div className="text-sm opacity-70">
          {status === 'loopback-failed' ? (
            <>
              Could not reach CLI on the configured port. Make sure
              <code> claude-autopilot dashboard login </code>
              is still running, then click Retry.
            </>
          ) : (
            <>Mint failed.</>
          )}
          {errMsg && <div className="mt-1 text-red-400">Detail: {errMsg}</div>}
          {status === 'loopback-failed' && minted && (
            <button
              type="button"
              onClick={retry}
              className="mt-3 underline opacity-80 hover:opacity-100"
            >
              Retry delivery (same key)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
