// apps/web/middleware.ts
//
// Refreshes the Supabase session cookie on every page request and on
// /api/auth/* routes only.
//
// Matcher excludes (codex final-pass WARNING #3):
//   - /_next/static, /_next/image (build artifacts)
//   - /favicon.ico, .svg/.png/.jpg/etc. (public assets)
//   - /api/health (platform health check)
//   - /api/* OTHER than /api/auth/* — Phase 2.2's ingest endpoints handle
//     auth themselves via signed-session JWTs, not via cookie refresh.
//     Forcing middleware on every ingest call would add latency + cookie
//     churn that's invisible to the operator.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    // Build-time / mis-deployed env: don't crash, just pass through.
    return response;
  }

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Touching auth.getUser() forces a session refresh if the access token
  // is close to expiry. The result is discarded here — the cookie writes
  // performed inside @supabase/ssr's setAll are the side effect we want.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // Match all request paths EXCEPT:
    // - /_next/static, /_next/image (build artifacts)
    // - /favicon.ico, image extensions (public assets)
    // - /api/health (platform health)
    // - /api/* not starting with /api/auth/ (ingest endpoints)
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$|api/health|api/(?!auth/)).*)',
  ],
};
