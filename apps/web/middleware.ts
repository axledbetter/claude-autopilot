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
//   3. Classifies the route as LOW or HIGH sensitivity
//      (`isHighSensitivityRoute`, v7.5.0).
//   4a. LOW: verifies the HMAC-signed `cao_membership_check` cookie.
//       On hit AND match AND not-expired, allow. On miss/mismatch/
//       expired, RPC + mint a fresh cookie. Worst-case revocation
//       window = cookie TTL (default 60s).
//   4b. HIGH (v7.5.0 — mutations + sensitive reads under
//       /api/dashboard/orgs/:id/{members,sso,audit,cost,billing} +
//       /api/dashboard/api-keys/*): SKIP the cookie cache, ALWAYS
//       RPC. Worst-case revocation window = 1 request. Also
//       asserts `:id` from the path matches the cookie active-org
//       (CRITICAL #2 — defense against a user active in Org A
//       reaching an Org B-scoped handler if the handler is sloppy).
//   5. On `check_membership_status` non-active result, clears
//      active-org + membership cookies and routes:
//        - page request: 302 → /access-revoked?reason=<code>
//        - API request:  403 JSON {error: <code>}
//   6. RPC errors / timeouts / missing secrets fall through to
//      `check_failed` (NOT `member_disabled` per codex pass-2 WARNING #4).
//
// Defense-in-depth (CRITICAL #3): high-sensitivity route handlers
// MUST also call `assertActiveMembershipForOrg()` at the top. The
// middleware is the outer optimization; the helper call is the
// inner correctness gate that doesn't depend on a regex list
// staying in sync with the route tree.
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
  getMembershipCheckTtlSeconds,
} from './lib/middleware/cookie-hmac';
import { isHighSensitivityRoute } from './lib/middleware/route-sensitivity';

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
// v7.1.2 — TTL is now resolved per-request via getMembershipCheckTtlSeconds()
// which reads MEMBERSHIP_CHECK_TTL_SECONDS env var (default 60, bounded
// [1, 3600]). Inlined at use-site to avoid module-load env reads.

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
  /** v7.5.0 — when true, the middleware skips the cookie cache and
   *  forces a per-request `check_membership_status` RPC. No new
   *  signed cookie is minted on success. */
  highSensitivity: boolean;
}

/** v7.5.0 — extract the `:orgId` path segment from a high-sensitivity
 *  `/api/dashboard/orgs/:orgId/...` request. Returns null when the
 *  path doesn't follow the org-scoped shape (api-keys/* and other
 *  non-org-scoped sensitive routes). */
export function parseOrgIdFromPath(pathname: string): string | null {
  const orgMatch = /^\/api\/dashboard\/orgs\/([^/]+)(\/|$)/.exec(pathname);
  if (!orgMatch) return null;
  const candidate = orgMatch[1];
  if (typeof candidate !== 'string') return null;
  return UUID_RE.test(candidate) ? candidate : null;
}

/** Phase 6 — perform the membership-revocation check. Returns either
 *  null (allow, mutations may still apply to refresh the cookie) or a
 *  terminal response (redirect / 403). */
async function evaluateRevocation(opts: RevocationCheckOpts): Promise<RevocationDecision> {
  const { request, isApi, userId, activeOrgId, highSensitivity } = opts;
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

  // v7.5.0 CRITICAL #2 — for high-sensitivity org-scoped routes,
  // assert the `:orgId` path segment matches the cookie-resolved
  // active org BEFORE running the RPC. This prevents a user active
  // in Org A from passing through to an Org B-scoped handler when
  // the handler's authorization is sloppy.
  if (highSensitivity) {
    const pathOrgId = parseOrgIdFromPath(request.nextUrl.pathname);
    if (pathOrgId !== null && pathOrgId !== activeOrgId) {
      return {
        terminal: buildRevocationResponse(request, isApi, 'no_membership'),
        mutations,
      };
    }
  }

  // v7.5.0 — high-sensitivity routes skip the cookie cache entirely.
  // Always RPC; never mint a new cookie (the cookie cache exists
  // specifically for low-sensitivity bursty navigation).
  if (!highSensitivity) {
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

  // 4) Positive result → mint a new signed cookie (default 60s TTL,
  //    operator-configurable via MEMBERSHIP_CHECK_TTL_SECONDS).
  //
  // v7.5.0 — for high-sensitivity routes we DO NOT mint a cookie on
  // success. The whole point of the high tier is per-request RPC;
  // minting here would let the cookie's later cache hit on a
  // low-sensitivity request bypass the next high-sensitivity check.
  // (Bypass is intentional & safe — it'd just become a low-tier
  // cache hit — but minting from a high-tier path muddies the
  // policy + costs us nothing to skip.)
  if (highSensitivity) {
    return { terminal: null, mutations };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = getMembershipCheckTtlSeconds();
  try {
    const signed = signMembershipCookie({
      orgId: activeOrgId,
      userId,
      status: 'active',
      role: result.role ?? 'member',
      exp: nowSeconds + ttlSeconds,
    });
    mutations.push({
      kind: 'set',
      name: MEMBERSHIP_CHECK_COOKIE,
      value: signed,
      options: { ...baseAttrs, maxAge: ttlSeconds },
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
    // v7.5.0 — route-sensitivity tiering. High = skip cookie cache,
    // always RPC. Low = existing v7.0 cookie path (≤60s revocation).
    const highSensitivity = isHighSensitivityRoute(pathname, request.method);
    const decision = await evaluateRevocation({
      request,
      isApi: surface.isApi,
      userId,
      activeOrgId,
      highSensitivity,
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
