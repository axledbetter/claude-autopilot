// apps/web/lib/auth/redirect.ts
//
// Whitelist for the OAuth callback `next` query param. Prevents open-redirect
// attacks where an attacker crafts a sign-in URL that lands the user on a
// malicious site after the legitimate Google OAuth round-trip.
//
// CHANGE POLICY (codex final-pass WARNING #4): any new authenticated route
// added in v7.0 Phase 2.2+ that should accept a ?next= redirect MUST update
// ALLOWED_REDIRECT_PATHS AND the redirect.test.ts fixture in the same PR.
// Reviewers reject PRs that add such a route without updating both. The
// silent fallback-to-`/` would otherwise look like lost navigation state.

const ALLOWED_REDIRECT_PATHS: readonly RegExp[] = [
  /^\/$/,
  /^\/dashboard(\/|$)/,
  /^\/runs(\/|$)/,
  /^\/settings(\/|$)/,
];

/** Resolve the OAuth callback `next` param to a safe same-origin path.
 *  Returns `/` for any malformed, scheme-relative, absolute, or
 *  non-allowlisted input. Normalizes whitespace + URL-encoded variants
 *  before validation (codex plan-review NOTE: encoded forms can bypass
 *  naive prefix checks). */
export function safeRedirect(next: string | null | undefined): string {
  if (!next) return '/';
  // Trim whitespace; refuse anything that decodes to a different value
  // (defense against encoded scheme-relative attacks like %2F%2Fevil.com).
  let normalized = next.trim();
  if (!normalized) return '/';
  try {
    const decoded = decodeURIComponent(normalized);
    if (decoded !== normalized) {
      // Re-validate the decoded form. If the decoded shape is rejected,
      // bail; if accepted, use the decoded form (canonical).
      normalized = decoded;
    }
  } catch {
    return '/';
  }
  // Reject scheme-relative (//evil.com) and absolute URLs (https://...).
  if (normalized.startsWith('//') || normalized.includes('://')) return '/';
  if (!ALLOWED_REDIRECT_PATHS.some(re => re.test(normalized))) return '/';
  return normalized;
}
