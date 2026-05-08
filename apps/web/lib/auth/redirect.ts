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
  // Phase 4: /cli-auth?cb=...&nonce=... — accept the path AND any query
  // string. The page itself re-validates cb + nonce server-side before
  // rendering the claim button.
  /^\/cli-auth(\?|$)/,
];

/** Resolve the OAuth callback `next` param to a safe same-origin path.
 *  Returns `/` for any malformed, scheme-relative, absolute, or
 *  non-allowlisted input. Normalizes whitespace + URL-encoded variants
 *  before validation (codex plan-review NOTE: encoded forms can bypass
 *  naive prefix checks).
 *
 *  Phase 4: handles paths with query strings (e.g. /cli-auth?cb=...&nonce=...)
 *  by validating the path-portion separately from the query. The query may
 *  legitimately contain percent-encoded `://` inside its values (a loopback
 *  callback URL passed as cb=) without that triggering the absolute-URL
 *  defense, which only applies to the path portion. */
export function safeRedirect(next: string | null | undefined): string {
  if (!next) return '/';
  // Trim whitespace; refuse anything that decodes to a different value
  // (defense against encoded scheme-relative attacks like %2F%2Fevil.com).
  let normalized = next.trim();
  if (!normalized) return '/';
  try {
    const decoded = decodeURIComponent(normalized);
    if (decoded !== normalized) {
      // Re-validate the decoded form. The path portion (pre-?) gets the
      // strict scheme-rejection treatment; the query portion is left alone
      // because percent-encoded `://` inside a query value is legitimate
      // (e.g. cb=http%3A%2F%2F127.0.0.1...).
      normalized = decoded;
    }
  } catch {
    return '/';
  }
  // Split path vs query for the scheme-relative / absolute-URL defense.
  const qIndex = normalized.indexOf('?');
  const pathPart = qIndex === -1 ? normalized : normalized.slice(0, qIndex);
  if (pathPart.startsWith('//') || pathPart.includes('://')) return '/';
  if (!ALLOWED_REDIRECT_PATHS.some(re => re.test(normalized))) return '/';
  return normalized;
}
