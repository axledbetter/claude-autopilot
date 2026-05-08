'use client';

import { useEffect, useState } from 'react';

const MAX_ATTEMPTS = 10;
const INTERVAL_MS = 2000;

interface MeResp {
  organizations?: Array<{ id: string }>;
  // We don't know the exact /me shape for plans yet — Phase 4 just polls
  // until non-error to keep the page simple. Phase 5 may inspect `plan`.
}

export default function SuccessPoller({ sessionId: _sessionId }: { sessionId: string | null }): React.ReactElement {
  const [status, setStatus] = useState<'polling' | 'done' | 'timeout'>('polling');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let n = 0;
    async function tick(): Promise<void> {
      while (!cancelled && n < MAX_ATTEMPTS) {
        n += 1;
        setAttempt(n);
        try {
          const r = await fetch('/api/dashboard/me', { credentials: 'include' });
          if (r.ok) {
            // Best-effort — the /me response confirms session is established;
            // webhook may still be processing but the user-facing UX is "ok".
            await r.json() as MeResp;
            setStatus('done');
            return;
          }
        } catch {
          // Ignore — retry.
        }
        await new Promise((res) => setTimeout(res, INTERVAL_MS));
      }
      if (!cancelled) setStatus('timeout');
    }
    void tick();
    return () => { cancelled = true; };
  }, []);

  if (status === 'done') {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-green-400 text-lg">All set.</p>
        <a href="/dashboard/billing" className="underline text-sm opacity-80 hover:opacity-100">
          View your billing →
        </a>
      </div>
    );
  }
  if (status === 'timeout') {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-amber-400 text-sm">
          Webhook is taking longer than expected. Refresh in a minute or
          contact support.
        </p>
        <a href="/dashboard/billing" className="underline text-sm opacity-80 hover:opacity-100">
          Open billing
        </a>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="animate-pulse text-sm opacity-70">Checking… (attempt {attempt}/{MAX_ATTEMPTS})</div>
    </div>
  );
}
