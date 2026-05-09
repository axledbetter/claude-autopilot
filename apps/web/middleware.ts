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
// Phase 6 — real-time membership revocation for /dashboard/** and
// /api/dashboard/** (excluding the org-bootstrap whitelist below). On
// every request the middleware:
//   1. Refreshes the Supabase auth cookie (existing).
//   2. Resolves (active_org, user.id) from cookies.
//   3. Verifies the HMAC-signed `cao_membership_check` cookie. On hit
//      AND match AND not-expired, allow.
//   4. On miss/mismatch/expired, calls `check_membership_status` RPC
//      with a 1.5s timeout. If `status='active'`, mints a new signed
//      cookie (60s TTL) and allows. Otherwise clears active-org +
//      membership cookies and routes:
//        - page request: 302 → /access-revoked?reason=<code>
//        - API request:  403 JSON {error: <code>}
//   5. RPC errors / timeouts / missing secrets fall through to
//      `check_failed` (NOT `member_disabled` per codex pass-2 WARNING #4).
//
// Status → reason mapping (single source of truth — see spec table):
//   active          → allow
//   disabled        → member_disabled
//   inactive        → member_inactive
//   invite_pending  → member_inactive
//   no_row          → no_membership
//   (RPC error)     → check_failed
//
// Runtime: explicitly Node.js (codex pass-3 CRITICAL #2 — Edge runtime
// does not expose `node:crypto` for HMAC + timingSafeEqual).
//
// Headers are set via NextResponse.next({ headers }) on the OUTGOING
// response — Server Component `headers()` reads request headers, not
// response (codex pass 2 WARNING #2).
//
// Single-response composition (codex pass-2 WARNING #1, pass-3 WARNING #4):
// the middleware tracks all cookie mutations in a per-request log and
// re-applies them onto the final response (whether pass / redirect /
// 403). Tests assert that BOTH Supabase refresh cookies AND membership
// cookies appear on every terminal shape.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import {
  checkMembershipStatus,
  MembershipCheckError,
  type MembershipStatus,
} from './lib/supabase/check-membership';
import {
  signMembershipCookie,
  verifyMembershipCookie,
} from './lib/middleware/cookie-hmac';

// Force Node.js runtime — node:crypto is not available on Edge.
export const runtime = 'nodejs';

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

// ---- Phase 6: revocation surface helpers --------------------------------

const ACTIVE_ORG_COOKIE = 'cao_active_org';
export const MEMBERSHIP_CHECK_COOKIE = 'cao_membership_check';
const MEMBERSHIP_TTL_SECONDS = 60;

/** Whitelisted /dashboard sub-paths that a user without an active org
 *  must be able to reach to bootstrap one. A revoked user landing on
 *  /dashboard/orgs/select sees the empty active-orgs list (filtered by
 *  status='active' in listActiveOrgs — codex pass-2 WARNING #7). */
const DASHBOARD_BOOTSTRAP_WHITELIST: ReadonlyArray<string> = [
  '/dashboard/orgs/select',
  '/dashboard/orgs/create',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Status → page redirect / API JSON reason mapping (single source of truth). */
export function statusToReason(status: MembershipStatus): 'member_disabled' | 'member_inactive' | 'no_membership' {
  switch (status) {
    case 'disabled': return 'member_disabled';
    case 'inactive': return 'member_inactive';
    case 'invite_pending': return 'member_inactive';
    case 'no_row': return 'no_membership';
    case 'active': return 'no_membership'; // unreachable — kept for exhaustiveness
  }
}

export function isRevocationSurfacePath(pathname: string): { match: boolean; isApi: boolean } {
  if (pathname === '/api/dashboard' || pathname.startsWith('/api/dashboard/')) {
    return { match: true, isApi: true };
  }
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
    return { match: true, isApi: false };
  }
  return { match: false, isApi: false };
}

export function isWhitelistedBootstrapPath(pathname: string): boolean {
  for (const w of DASHBOARD_BOOTSTRAP_WHITELIST) {
    if (pathname === w || pathname.startsWith(`${w}/`)) return true;
  }
  return false;
}

/** Cookie attributes shared across set/clear of the membership cookie. */
function membershipCookieBaseAttrs(): {
  httpOnly: boolean;
  sameSite: 'lax';
  path: string;
  secure: boolean;
} {
  // Per spec: HttpOnly + SameSite=Lax + Path=/. Secure ON except in
  // NODE_ENV=test/development.
  const env = process.env.NODE_ENV ?? 'development';
  const secure = env !== 'test' && env !== 'development';
  return { httpOnly: true, sameSite: 'lax', path: '/', secure };
}

interface CookieMutation {
  kind: 'set' | 'clear';
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/** Apply queued cookie mutations onto a target response. The response
 *  may have been replaced (e.g. redirect or 403 JSON), so this re-plays
 *  the auth-refresh + membership cookie ops. */
function applyMutations(response: NextResponse, mutations: CookieMutation[]): void {
  for (const m of mutations) {
    if (m.kind === 'clear') {
      // Clearing means "Max-Age=0" with a Set-Cookie. Cookie API supports
      // .delete() but for cross-platform safety we set value='' + Max-Age=0.
      response.cookies.set(m.name, '', { ...m.options, maxAge: 0 });
    } else {
      response.cookies.set(m.name, m.value, m.options);
    }
  }
}

function applyCliAuthHeaders(response: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CLI_AUTH_HEADERS)) {
    response.headers.set(k, v);
  }
  return response;
}

interface RevocationDecision {
  /** When set, terminate request with this response. */
  terminal: NextResponse | null;
  /** New membership-cookie set/clear ops to apply to the FINAL response. */
  mutations: CookieMutation[];
}

/** Build the terminal response for a revocation decision. */
function buildRevocationResponse(
  request: NextRequest,
  isApi: boolean,
  reason: 'member_disabled' | 'member_inactive' | 'no_membership' | 'check_failed',
): NextResponse {
  if (isApi) {
    return NextResponse.json({ error: reason }, { status: 403 });
  }
  const url = new URL('/access-revoked', request.url);
  url.searchParams.set('reason', reason);
  return NextResponse.redirect(url);
}

/** Build the terminal response when the user has no active-org cookie
 *  and is hitting a /dashboard or /api/dashboard surface that REQUIRES
 *  one (i.e. not the bootstrap whitelist). */
function buildNoActiveOrgResponse(
  request: NextRequest,
  isApi: boolean,
): NextResponse {
  if (isApi) {
    return NextResponse.json({ error: 'no_active_org' }, { status: 403 });
  }
  // Page request: redirect to /dashboard/orgs/select to let the user
  // pick (or see "no active organizations" if they have none).
  const url = new URL('/dashboard/orgs/select', request.url);
  return NextResponse.redirect(url);
}

interface RevocationCheckOpts {
  request: NextRequest;
  isApi: boolean;
  userId: string | null;
  activeOrgId: string | null;
}

/** Phase 6 — perform the membership-revocation check. Returns either
 *  null (allow, mutations may still apply to refresh the cookie) or a
 *  terminal response (redirect / 403). */
async function evaluateRevocation(opts: RevocationCheckOpts): Promise<RevocationDecision> {
  const { request, isApi, userId, activeOrgId } = opts;
  const mutations: CookieMutation[] = [];
  const baseAttrs = membershipCookieBaseAttrs();

  // No authenticated user — let downstream auth handle it (we do not
  // redirect to login here; the page / route's existing auth gate
  // handles unauthenticated requests).
  if (!userId) {
    return { terminal: null, mutations };
  }

  // No active org cookie — fail closed for APIs, redirect to selector
  // for pages.
  if (!activeOrgId) {
    return {
      terminal: buildNoActiveOrgResponse(request, isApi),
      mutations,
    };
  }

  // 1) Try the signed cookie cache.
  const cookieRaw = request.cookies.get(MEMBERSHIP_CHECK_COOKIE)?.value;
  const verified = verifyMembershipCookie(cookieRaw);
  if (
    verified.ok &&
    verified.payload.orgId === activeOrgId &&
    verified.payload.userId === userId
  ) {
    // Cache hit AND matches THIS request's identity. No DB call.
    return { terminal: null, mutations };
  }

  // 2) Cache miss / forged / expired / wrong identity → RPC.
  let result: { status: MembershipStatus; role: 'owner' | 'admin' | 'member' | null };
  try {
    result = await checkMembershipStatus(activeOrgId, userId);
  } catch (err) {
    // RPC failure / timeout / secret missing → check_failed (distinct
    // from member_disabled per codex pass-2 WARNING #4).
    const code = err instanceof MembershipCheckError ? err.code : 'unknown';
    const subcode = err instanceof MembershipCheckError ? err.subcode : undefined;
    process.stderr.write(
      `[middleware:revocation] check_failed code=${code}` +
      (subcode ? ` subcode=${subcode}` : '') +
      ` orgId=${activeOrgId} userId=${userId}\n`,
    );
    // Clear membership cookie so a stale signed cache doesn't keep
    // resurrecting after the operator fixes the underlying error.
    mutations.push({
      kind: 'clear',
      name: MEMBERSHIP_CHECK_COOKIE,
      value: '',
      options: baseAttrs,
    });
    return {
      terminal: buildRevocationResponse(request, isApi, 'check_failed'),
      mutations,
    };
  }

  // 3) Negative result (status ≠ active) → revoke.
  if (result.status !== 'active') {
    const reason = statusToReason(result.status);
    // Clear active-org + membership cookies on revocation.
    mutations.push({
      kind: 'clear',
      name: ACTIVE_ORG_COOKIE,
      value: '',
      options: { ...baseAttrs, httpOnly: false /* active-org cookie is readable by client */ },
    });
    mutations.push({
      kind: 'clear',
      name: MEMBERSHIP_CHECK_COOKIE,
      value: '',
      options: baseAttrs,
    });
    return {
      terminal: buildRevocationResponse(request, isApi, reason),
      mutations,
    };
  }

  // 4) Positive result → mint a new signed cookie (60s TTL).
  const nowSeconds = Math.floor(Date.now() / 1000);
  try {
    const signed = signMembershipCookie({
      orgId: activeOrgId,
      userId,
      status: 'active',
      role: result.role ?? 'member',
      exp: nowSeconds + MEMBERSHIP_TTL_SECONDS,
    });
    mutations.push({
      kind: 'set',
      name: MEMBERSHIP_CHECK_COOKIE,
      value: signed,
      options: { ...baseAttrs, maxAge: MEMBERSHIP_TTL_SECONDS },
    });
  } catch (err) {
    // Sign failed (secret missing). Allow the request through this
    // time — the user is verifiably active per the RPC — but log it.
    const code = err instanceof MembershipCheckError ? err.code : 'unknown';
    process.stderr.write(
      `[middleware:revocation] sign_failed code=${code} (cookie not minted; RPC will run again next request)\n`,
    );
  }
  return { terminal: null, mutations };
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isCliAuth = isCliAuthPath(pathname);

  // Track all cookie ops Supabase performs during getUser() so we can
  // re-play them onto whatever final response we return (pass /
  // redirect / 403). Codex pass-2 WARNING #1 / pass-3 WARNING #4.
  const cookieOps: CookieMutation[] = [];

  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    // Build-time / mis-deployed env: don't crash, just pass through.
    if (isCliAuth) applyCliAuthHeaders(response);
    return response;
  }

  let userId: string | null = null;
  try {
    const supabase = createServerClient(url, anon, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
            // Record so we can re-play onto a replaced (redirect/403) response.
            cookieOps.push({
              kind: 'set',
              name,
              value,
              options: (options ?? {}) as Record<string, unknown>,
            });
          });
        },
      },
    });

    // Touching auth.getUser() forces a session refresh if the access token
    // is close to expiry. The result drives the Phase 6 revocation check.
    const { data: { user } } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch (err) {
    // Auth refresh failure shouldn't crash the middleware. Log and
    // continue — downstream route handlers will see no user.
    process.stderr.write(
      `[middleware] auth.getUser failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Phase 6 — revocation surface check (only for /dashboard/** and
  // /api/dashboard/** OTHER than the bootstrap whitelist).
  const surface = isRevocationSurfacePath(pathname);
  if (surface.match && !isWhitelistedBootstrapPath(pathname)) {
    const cookieOrgRaw = request.cookies.get(ACTIVE_ORG_COOKIE)?.value;
    const activeOrgId = cookieOrgRaw && UUID_RE.test(cookieOrgRaw) ? cookieOrgRaw : null;
    const decision = await evaluateRevocation({
      request,
      isApi: surface.isApi,
      userId,
      activeOrgId,
    });
    if (decision.terminal) {
      // Re-apply Supabase refresh cookies + revocation mutations on the
      // terminal response so cookies aren't lost on redirect/403.
      applyMutations(decision.terminal, cookieOps);
      applyMutations(decision.terminal, decision.mutations);
      if (isCliAuth) applyCliAuthHeaders(decision.terminal);
      return decision.terminal;
    }
    // Pass-through. Apply any new mutations (e.g. fresh signed cookie)
    // onto the existing response.
    applyMutations(response, decision.mutations);
  }

  if (isCliAuth) applyCliAuthHeaders(response);
  return response;
}

export const config = {
  matcher: [
    // Match all request paths EXCEPT:
    // - /_next/static, /_next/image (build artifacts)
    // - /favicon.ico, image extensions (public assets)
    // - /api/health (platform health)
    // - /api/* not starting with /api/auth/ or /api/dashboard/
    //   (other ingest endpoints handle auth themselves via signed JWT)
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$|api/health|api/(?!auth/|dashboard)).*)',
  ],
};
