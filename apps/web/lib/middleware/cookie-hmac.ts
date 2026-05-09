// apps/web/lib/middleware/cookie-hmac.ts
//
// Phase 6 — HMAC sign/verify for the `cao_membership_check` cookie used
// by the dashboard middleware to cache `(orgId, userId, status, role,
// exp)` for 60s.
//
// Format: base64url(payload) + "." + base64url(hmacSha256(secret, payload))
//
// Secret validation runs on FIRST USE (lazy/runtime) per codex pass-2
// WARNING #3. Module-load validation breaks `next build` in CI when the
// secret isn't injected at build time. Throwing the typed
// `MembershipCheckError({code: 'cookie_secret_missing'})` from the first
// helper call lets the middleware catch and fail closed at runtime.
//
// v7.1.1 — DUAL-SECRET ROTATION SUPPORT.
//
// To rotate `MEMBERSHIP_CHECK_COOKIE_SECRET` without invalidating every
// outstanding cookie at once (= thundering herd of RPC calls when every
// active dashboard user falls through to check_membership_status on the
// next request), set the OLD secret as `MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS`
// when you set the NEW value as `MEMBERSHIP_CHECK_COOKIE_SECRET`. Verify
// tries CURRENT first; if signature mismatches, tries PREVIOUS. New
// cookies are always signed with CURRENT. Once 60s elapses (the cookie
// TTL), every cached cookie is signed with CURRENT; you can drop
// PREVIOUS at the next deploy.
//
// Rotation flow for operators:
//   1. Generate new secret: NEW=$(openssl rand -hex 32)
//   2. Set MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS = current value
//   3. Set MEMBERSHIP_CHECK_COOKIE_SECRET = NEW
//   4. Deploy.
//   5. Wait ≥60s (one cookie TTL — every cached cookie has now been
//      re-signed with NEW).
//   6. (Optional next deploy) Unset MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { MembershipCheckError } from '../supabase/check-membership';

const MIN_SECRET_BYTES = 32;

/** Membership cookie payload — narrow shape (5 fields). */
export interface MembershipCookiePayload {
  orgId: string;
  userId: string;
  status: 'active';
  role: 'owner' | 'admin' | 'member';
  /** Epoch seconds. checkedAt + 60. */
  exp: number;
}

/** Lazily resolve the HMAC secret. Throws MembershipCheckError on first
 *  call when the env var is missing or shorter than 32 bytes. The
 *  middleware catches this, logs it, and fails closed. */
export function getMembershipCheckSecret(): string {
  const raw = process.env.MEMBERSHIP_CHECK_COOKIE_SECRET;
  if (!raw || typeof raw !== 'string') {
    throw new MembershipCheckError({
      code: 'cookie_secret_missing',
      message: 'MEMBERSHIP_CHECK_COOKIE_SECRET is not set',
    });
  }
  // Treat the secret as bytes — accept hex or utf8. Anything < 32 bytes
  // is too weak; reject up front.
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes < MIN_SECRET_BYTES) {
    throw new MembershipCheckError({
      code: 'cookie_secret_missing',
      subcode: 'too_short',
      message: `MEMBERSHIP_CHECK_COOKIE_SECRET must be ≥${MIN_SECRET_BYTES} bytes (got ${bytes})`,
    });
  }
  return raw;
}

/** v7.1.1 — Resolve the OPTIONAL previous-generation HMAC secret used
 *  during a rotation window. Returns `null` when unset (the common case
 *  outside an active rotation). When set but malformed/too-short, returns
 *  `null` AND emits a one-shot warn so operators see the misconfig but
 *  don't suffer a hard outage during rotation. (Verify can still succeed
 *  via the CURRENT secret in that case.) */
let warnedAboutInvalidPrevious = false;
export function getPreviousMembershipCheckSecret(): string | null {
  const raw = process.env.MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS;
  if (!raw || typeof raw !== 'string') return null;
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes < MIN_SECRET_BYTES) {
    if (!warnedAboutInvalidPrevious) {
      warnedAboutInvalidPrevious = true;
      console.warn(
        `[cookie-hmac] MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS is set but `
          + `<${MIN_SECRET_BYTES} bytes (got ${bytes}); ignoring. Cookies signed `
          + `with the previous secret will fail verification and fall through to RPC.`,
      );
    }
    return null;
  }
  return raw;
}

// Test seam — reset the one-shot warn latch between tests.
export function _resetPreviousSecretWarnLatchForTests(): void {
  warnedAboutInvalidPrevious = false;
}

// ---- v7.1.2 — Configurable membership-check TTL --------------------------
//
// Default 60 seconds (Phase 6 baseline). Enterprise customers can tighten
// the dashboard revocation window via `MEMBERSHIP_CHECK_TTL_SECONDS`.
//
// Bounded [1, 3600]: a TTL ≤0 would defeat the cache entirely (every
// dashboard request hits Supabase = ~50-200ms latency overhead per nav);
// a TTL >1h would exceed the documented "≤60s revocation latency" v7.0
// guarantee in the runbook. Values outside the bound fall back to 60
// with a one-shot warn — same pattern as the previous-secret validator.

export const MEMBERSHIP_TTL_DEFAULT_SECONDS = 60;
const MEMBERSHIP_TTL_MIN_SECONDS = 1;
const MEMBERSHIP_TTL_MAX_SECONDS = 3600;

let warnedAboutInvalidTtl = false;

/** Resolve the membership-check cookie TTL in seconds. Returns the
 *  default (60) on missing / non-numeric / out-of-bound values, with a
 *  one-shot warn for the misconfig (so operators see it once, not on
 *  every request). */
export function getMembershipCheckTtlSeconds(): number {
  const raw = process.env.MEMBERSHIP_CHECK_TTL_SECONDS;
  if (!raw || typeof raw !== 'string') return MEMBERSHIP_TTL_DEFAULT_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    if (!warnedAboutInvalidTtl) {
      warnedAboutInvalidTtl = true;
      console.warn(
        `[cookie-hmac] MEMBERSHIP_CHECK_TTL_SECONDS=${JSON.stringify(raw)} is `
          + `not a valid integer; using default ${MEMBERSHIP_TTL_DEFAULT_SECONDS}s.`,
      );
    }
    return MEMBERSHIP_TTL_DEFAULT_SECONDS;
  }
  if (parsed < MEMBERSHIP_TTL_MIN_SECONDS || parsed > MEMBERSHIP_TTL_MAX_SECONDS) {
    if (!warnedAboutInvalidTtl) {
      warnedAboutInvalidTtl = true;
      console.warn(
        `[cookie-hmac] MEMBERSHIP_CHECK_TTL_SECONDS=${parsed} is outside `
          + `[${MEMBERSHIP_TTL_MIN_SECONDS}, ${MEMBERSHIP_TTL_MAX_SECONDS}]; `
          + `using default ${MEMBERSHIP_TTL_DEFAULT_SECONDS}s.`,
      );
    }
    return MEMBERSHIP_TTL_DEFAULT_SECONDS;
  }
  return parsed;
}

// Test seam — reset the one-shot warn latch between tests.
export function _resetTtlWarnLatchForTests(): void {
  warnedAboutInvalidTtl = false;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

/** Produce the signed cookie value `<payload>.<sig>`. Throws via
 *  `getMembershipCheckSecret()` if the env secret is missing. */
export function signMembershipCookie(payload: MembershipCookiePayload): string {
  const secret = getMembershipCheckSecret();
  const json = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(Buffer.from(json, 'utf8'));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = base64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

/** Result discriminator for verifyMembershipCookie. */
export type VerifyResult =
  | { ok: true; payload: MembershipCookiePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'invalid_payload' };

/** Verify the cookie's signature, decode the payload, and check that the
 *  declared `exp` is still in the future (now in epoch seconds).
 *
 *  Forging a valid cookie requires the secret. An unsigned, tampered, or
 *  expired cookie is treated as a cache miss by the middleware (caller
 *  falls through to the RPC).
 *
 *  Constant-time signature comparison via `crypto.timingSafeEqual`. */
export function verifyMembershipCookie(
  raw: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const idx = raw.indexOf('.');
  if (idx <= 0 || idx === raw.length - 1) {
    return { ok: false, reason: 'malformed' };
  }
  const payloadB64 = raw.slice(0, idx);
  const sigB64 = raw.slice(idx + 1);

  let secret: string;
  try {
    secret = getMembershipCheckSecret();
  } catch {
    // Secret missing — caller's middleware translates this into
    // check_failed. From the cookie's POV, treat as a cache miss.
    return { ok: false, reason: 'malformed' };
  }

  let actual: Buffer;
  try {
    actual = base64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // v7.1.1 — try CURRENT first, then PREVIOUS (during rotation only).
  // Constant-time compare on each candidate. We don't return early on
  // length mismatch from CURRENT before checking PREVIOUS — both
  // candidates produce the same fixed length (32 bytes for SHA256), so
  // a length mismatch implies the cookie is malformed regardless.
  const expectedCurrent = createHmac('sha256', secret).update(payloadB64).digest();
  if (actual.length !== expectedCurrent.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  let signatureOk = timingSafeEqual(actual, expectedCurrent);
  if (!signatureOk) {
    const previous = getPreviousMembershipCheckSecret();
    if (previous) {
      const expectedPrevious = createHmac('sha256', previous).update(payloadB64).digest();
      // Lengths are guaranteed to match (both SHA256 = 32 bytes) — already
      // checked actual.length above.
      signatureOk = timingSafeEqual(actual, expectedPrevious);
    }
  }
  if (!signatureOk) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payloadJson: string;
  try {
    payloadJson = base64urlDecode(payloadB64).toString('utf8');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  let payload: MembershipCookiePayload;
  try {
    payload = JSON.parse(payloadJson) as MembershipCookiePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof payload.orgId !== 'string' ||
    typeof payload.userId !== 'string' ||
    payload.status !== 'active' ||
    (payload.role !== 'owner' && payload.role !== 'admin' && payload.role !== 'member') ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'invalid_payload' };
  }

  if (payload.exp <= nowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}
