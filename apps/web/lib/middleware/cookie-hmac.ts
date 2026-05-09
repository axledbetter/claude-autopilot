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

  const expected = createHmac('sha256', secret).update(payloadB64).digest();
  let actual: Buffer;
  try {
    actual = base64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (actual.length !== expected.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(actual, expected)) {
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
