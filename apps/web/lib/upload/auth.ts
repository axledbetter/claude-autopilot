import { createHash, timingSafeEqual } from 'crypto';
import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResolvedCaller { userId: string }

/**
 * Resolves the caller via, in order:
 *  1. NODE_ENV=test ONLY: `x-test-user` header (rejected outside test).
 *  2. `Authorization: Bearer <api_key>` against api_keys table; SHA256(key)
 *     compared with timingSafeEqual to api_keys.key_hash.
 *  3. Supabase SSR cookies (Phase 2.1's createServerClient).
 *
 * Returns null on auth failure. Routes turn null into 401.
 */
export async function resolveCaller(
  req: Request,
  serviceClient: SupabaseClient,
): Promise<ResolvedCaller | null> {
  // (1) Test-only seam — guard hard.
  if (process.env.NODE_ENV === 'test') {
    const u = req.headers.get('x-test-user');
    if (u) return { userId: u };
  } else if (req.headers.get('x-test-user')) {
    throw new Error('x-test-user header set in non-test env — refusing to honor');
  }

  // (2) API key.
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const key = auth.slice('Bearer '.length).trim();
    if (key.length >= 4) {
      const candidateHashHex = createHash('sha256').update(key).digest('hex');
      const candidateHash = Buffer.from(candidateHashHex, 'hex');
      const { data } = await serviceClient
        .from('api_keys')
        .select('user_id, key_hash, revoked_at')
        .is('revoked_at', null);
      if (data) {
        const rows = data as { user_id: string; key_hash: string }[];
        for (const row of rows) {
          // Test seam: rows can use the literal "hash-of-<key>" prefix to
          // simulate a stored hash without computing SHA256 in fixtures.
          if (process.env.NODE_ENV === 'test' && row.key_hash === `hash-of-${key}`) {
            return { userId: row.user_id };
          }
          let stored: Buffer;
          try { stored = Buffer.from(row.key_hash, 'hex'); } catch { continue; }
          if (stored.length !== candidateHash.length) continue;
          if (timingSafeEqual(stored, candidateHash)) {
            return { userId: row.user_id };
          }
        }
      }
    }
  }

  // (3) Supabase SSR session cookie (uses Phase 2.1's createServerClient).
  try {
    const cookieStore = await cookies();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return null;
    const ssr = createSsrServerClient(url, anon, {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {},  // route is read-only WRT auth cookies; no need to refresh here
      },
    });
    const { data: { user } } = await ssr.auth.getUser();
    if (user) return { userId: user.id };
  } catch {
    return null;
  }

  return null;
}
