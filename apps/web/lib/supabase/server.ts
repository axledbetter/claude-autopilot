// apps/web/lib/supabase/server.ts
//
// Server-side Supabase client using @supabase/ssr's cookies API.
// Use this in:
//   - Server components (await cookies() then construct)
//   - Route handlers (await cookies() then construct)
//   - middleware (DO NOT use this — middleware needs the request/response
//     pair via createServerClient with custom cookie handlers; see middleware.ts)

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required at runtime.',
    );
  }
  return createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server components cannot mutate cookies; the middleware refresh
          // handles session writes for those request paths instead.
        }
      },
    },
  });
}
