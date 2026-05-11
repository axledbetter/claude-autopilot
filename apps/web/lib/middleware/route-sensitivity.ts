// apps/web/lib/middleware/route-sensitivity.ts
//
// v7.5.0 — route-sensitivity classifier for membership-revocation policy.
//
// The v7.0 Phase 6 cookie cache (60s) keeps low-risk dashboard
// navigation fast (≤60s revocation window). For HIGH-sensitivity
// routes (mutations, audit logs, cost reports, SSO config, API key
// admin) the middleware skips the cookie cache entirely and runs the
// `check_membership_status` RPC on every request → ≤1-request
// revocation window.
//
// This module declares the HIGH list. Anything not matched here is
// LOW (default cookie cache).
//
// CRITICAL #3 (codex pass-2): middleware regex matching is brittle
// — adding a new sensitive GET route without updating this list would
// silently default to the cached low-sensitivity branch. Defense-in-
// depth comes from `assertActiveMembershipForOrg` in
// `app/lib/dashboard/assert-active-membership-for-org.ts`, which
// MUST be called at the top of every high-sensitivity route handler
// as the inner correctness gate. This middleware list is the outer
// optimization layer.

/**
 * GET-method routes that ALSO require per-request RPC (sensitive
 * reads). All non-GET methods on `/api/dashboard/**` are
 * automatically high-sensitivity (see `isHighSensitivityRoute`).
 *
 * Patterns are matched against the request pathname (no method
 * prefix, no querystring). Each entry is anchored at the start and
 * uses an explicit segment terminator (`/` or `$`) to prevent
 * boundary collisions like `/cost-something-else` matching the
 * `/cost` rule.
 */
export const HIGH_SENSITIVITY_PATTERNS: ReadonlyArray<RegExp> = [
  // Audit logs — admin-only, sensitive read.
  /^\/api\/dashboard\/orgs\/[^/]+\/audit(\/|$)/,
  // Cost reports JSON + CSV (path uses `cost` and `cost.csv`).
  /^\/api\/dashboard\/orgs\/[^/]+\/cost(\.csv)?(\/|$)/,
  // SSO config (read exposes connection IDs / domains).
  /^\/api\/dashboard\/orgs\/[^/]+\/sso(\/|$)/,
  // Members list — exposes admin/owner identities + emails.
  /^\/api\/dashboard\/orgs\/[^/]+\/members(\/|$)/,
  // Billing settings (everything below /billing/, including portal/checkout return states).
  /^\/api\/dashboard\/orgs\/[^/]+\/billing(\/|$)/,
  // API keys — listing is sensitive (codex W4 — even the GET is admin-class).
  /^\/api\/dashboard\/api-keys(\/|$)/,
];

/**
 * Returns true when the request must skip the membership-check
 * cookie cache and run the per-request RPC instead.
 *
 * Policy:
 *  - Non-GET on any `/api/dashboard/**` route → high-sensitivity
 *    (mutations always pay the RPC cost; the cookie's stale-window
 *    is not acceptable for state-changing operations).
 *  - GET requests are LOW by default; they're high only if their
 *    pathname matches one of `HIGH_SENSITIVITY_PATTERNS`.
 *  - Page renders (`/dashboard/**` non-API) are always LOW — the
 *    cookie cache exists specifically because page loads fan out to
 *    many GETs in a short burst.
 */
export function isHighSensitivityRoute(pathname: string, method: string): boolean {
  const m = (method ?? 'GET').toUpperCase();
  // Non-GET on the API surface → always high.
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && pathname.startsWith('/api/dashboard/')) {
    return true;
  }
  // GET routes are high only if explicitly listed.
  return HIGH_SENSITIVITY_PATTERNS.some((re) => re.test(pathname));
}
