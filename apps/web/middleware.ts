// apps/web/middleware.ts
//
// Refreshes the Supabase session cookie on every page request and on
// /api/auth/* routes only.
//
// Phase 4 — also applies hardened response headers to /cli-auth:
//   - Cache-Control: no-store, no-cache, must-revalidate
//   - Referrer-Policy: no-referrer
//   - Content-Security-Policy with connect-src exception for loopback
//     (codex CRITICAL #1 — exact value asserted by test 26)
//   - X-Frame-Options: DENY
//
// Headers are set via NextResponse.next({ headers }) on the OUTGOING
// response — Server Component `headers()` reads request headers, not
// response (codex pass 2 WARNING #2).
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

// Exported for tests — codex CRITICAL #1 anchor (test 26 asserts the
// exact CSP value the middleware applies to /cli-auth).
export const CLI_AUTH_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' http://127.0.0.1:* http://localhost:*",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const CLI_AUTH_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CLI_AUTH_CSP,
  'X-Frame-Options': 'DENY',
};

export function isCliAuthPath(pathname: string): boolean {
  return pathname === '/cli-auth' || pathname.startsWith('/cli-auth/');
}

function applyCliAuthHeaders(response: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CLI_AUTH_HEADERS)) {
    response.headers.set(k, v);
  }
  return response;
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const isCliAuth = isCliAuthPath(request.nextUrl.pathname);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    // Build-time / mis-deployed env: don't crash, just pass through.
    if (isCliAuth) applyCliAuthHeaders(response);
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

  if (isCliAuth) applyCliAuthHeaders(response);

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
