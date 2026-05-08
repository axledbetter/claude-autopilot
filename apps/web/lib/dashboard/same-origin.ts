// Same-origin guard for cookie-authenticated mutating routes.
//
// CORS isn't sufficient — cookies travel with cross-origin POST + a
// malicious page could trigger the request from a same-origin reflected
// XSS or a cooperating subdomain.
//
// Codex plan-pass WARNING: assertSameOrigin compares against
// `loadPublicBillingConfig().AUTOPILOT_PUBLIC_BASE_URL` (the canonical
// configured origin) NOT `new URL(req.url).origin`. The latter would be
// the internal container URL behind a proxy and would mismatch every
// browser request.
//
// Routes that gain the guard:
//   - POST /api/dashboard/api-keys/mint (cookie-only)
//   - POST /api/dashboard/api-keys/revoke (cookie OR API key — guard only on cookie)
//   - PATCH /api/dashboard/runs/:runId/visibility (cookie-only)
//   - POST /api/dashboard/billing/checkout (cookie-only)
//   - POST /api/dashboard/billing/portal (cookie-only)
//
// Bypass for API-key callers: when `Authorization: Bearer clp_...` is
// present, the route should skip this check — non-browser callers don't
// reliably set Origin.

import { loadPublicBillingConfig } from '@/lib/billing/plan-map';

export type SameOriginResult = { ok: true } | { ok: false; reason: string };

export function assertSameOrigin(req: Request): SameOriginResult {
  const origin = req.headers.get('origin');
  if (!origin) return { ok: false, reason: 'missing origin' };
  let expected: string;
  try {
    expected = new URL(loadPublicBillingConfig().AUTOPILOT_PUBLIC_BASE_URL).origin;
  } catch (err) {
    // Misconfigured public base URL — fail closed rather than allow.
    return { ok: false, reason: `bad expected origin: ${(err as Error).message}` };
  }
  if (origin !== expected) {
    return { ok: false, reason: `origin mismatch: ${origin} != ${expected}` };
  }
  return { ok: true };
}
