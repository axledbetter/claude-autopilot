// Phase 4 — Spec test 27: unauthenticated /cli-auth?cb=X&nonce=Y
// redirects to /?next=<encoded>, and the encoded next preserves both
// params after a Supabase login round-trip (URL-encoded round-trip test).

import { describe, it, expect } from 'vitest';
import { safeRedirect } from '@/lib/auth/redirect';

describe('cli-auth unauth redirect round-trip', () => {
  it('test 27: nested next param preserves cb + nonce', () => {
    const cb = 'http://127.0.0.1:56010/cli-callback';
    const nonce = 'd'.repeat(32);

    // Step 1 — what the /cli-auth Server Component builds when user is unauthenticated.
    const cliAuthQuery = new URLSearchParams({ cb, nonce }).toString();
    const next = `/cli-auth?${cliAuthQuery}`;
    const homeQuery = new URLSearchParams({ next }).toString();
    const homeWithNext = `/?${homeQuery}`;

    // Step 2 — sanity: the URL is parseable and `next` round-trips.
    const u = new URL(homeWithNext, 'https://autopilot.dev');
    const recoveredNext = u.searchParams.get('next');
    expect(recoveredNext).toBe(next);

    // Step 3 — once Supabase OAuth returns to /api/auth/callback,
    // it passes `next` through safeRedirect. The result must still
    // carry both params.
    const safe = safeRedirect(recoveredNext);
    expect(safe.startsWith('/cli-auth')).toBe(true);
    const safeUrl = new URL(safe, 'https://autopilot.dev');
    expect(safeUrl.searchParams.get('cb')).toBe(cb);
    expect(safeUrl.searchParams.get('nonce')).toBe(nonce);
  });
});
