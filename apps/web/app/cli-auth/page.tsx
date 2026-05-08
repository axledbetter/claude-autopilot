// /cli-auth — Phase 4. Completes the Phase 2.3 CLI dashboard login flow.
//
// Flow:
//   1. Server-side validate cb (loopback, port 56000-56050) + nonce (32 hex).
//      Either fail → render <InvalidParams> 400 page, do NOT proceed.
//   2. Auth gate. If not signed in, redirect to /?next=<encoded /cli-auth>
//      with both params preserved via URLSearchParams.
//   3. Authenticated → render <CliAuthClaim> (client component).
//      Client mints API key via /api/dashboard/api-keys/mint, then POSTs to
//      the cb URL with mode: 'cors'. Loopback listener answers with CORS
//      headers + { ok, nonce } body.
//
// Hard rules (codex CRITICAL #1, codex pass 2 WARNING #2):
//   - Server Component MUST validate cb URL before rendering anything
//     interactive. Reject invalid cb to prevent open redirect via the
//     client-side fetch target.
//   - API key is NEVER passed through Server Component as a prop. Mint
//     happens client-side after hydration.
//   - Response headers (Cache-Control, CSP, Referrer-Policy) are set in
//     middleware.ts, NOT here. headers() in a Server Component reads
//     request headers, not response.

import { redirect } from 'next/navigation';
import { validateCallbackUrl } from '@/lib/dashboard/callback-url';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import CliAuthClaim from './_components/CliAuthClaim';

export const dynamic = 'force-dynamic';

const NONCE_RE = /^[0-9a-f]{32}$/;

function InvalidParams({ reason }: { reason: string }): React.ReactElement {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-2xl font-bold mb-4">Invalid CLI auth request</h1>
      <p className="opacity-70 mb-2">Reason: {reason}</p>
      <p className="opacity-60 text-sm">
        This page is only opened by <code>claude-autopilot dashboard login</code>.
        If you arrived here from a link or email, close this tab.
      </p>
    </main>
  );
}

export default async function CliAuthPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
): Promise<React.ReactElement> {
  const params = await searchParams;
  const cbRaw = typeof params.cb === 'string' ? params.cb : null;
  const nonceRaw = typeof params.nonce === 'string' ? params.nonce : null;

  if (!cbRaw || !nonceRaw) {
    return <InvalidParams reason="missing cb or nonce" />;
  }
  if (!validateCallbackUrl(cbRaw)) {
    return <InvalidParams reason="invalid callback URL (must be loopback, port 56000-56050)" />;
  }
  if (!NONCE_RE.test(nonceRaw)) {
    return <InvalidParams reason="invalid nonce (must be 32 hex chars)" />;
  }

  // Auth gate.
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    // Build the next URL with URLSearchParams to preserve nested cb+nonce
    // through Supabase OAuth round-trip (codex pass 2 WARNING — naive
    // concat loses params past the first &).
    const cliAuthQuery = new URLSearchParams({ cb: cbRaw, nonce: nonceRaw }).toString();
    const next = `/cli-auth?${cliAuthQuery}`;
    const homeWithNext = `/?${new URLSearchParams({ next }).toString()}`;
    redirect(homeWithNext);
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-2xl font-bold mb-2">Sign in CLI</h1>
      <p className="opacity-70 mb-6 text-sm">
        Request from <code>claude-autopilot</code> · nonce <code>{nonceRaw.slice(0, 8)}…</code>
      </p>
      <CliAuthClaim cb={cbRaw} nonce={nonceRaw} accountEmail={user.email ?? ''} />
    </main>
  );
}
