// Phase 5.4 — WorkOS SDK singleton + webhook signature verifier.
//
// Lazy singleton so importing this module on the client/SSR path doesn't
// require WORKOS_API_KEY at module-load time. The SDK is only constructed
// when an actual route handler invokes getWorkOS().
//
// constructEvent throws on:
//   - missing/malformed signature header
//   - signature mismatch
//   - timestamp older than tolerance (default 5min — replay protection)
// We wrap it so callers get a typed result without needing to catch.

import { WorkOS } from '@workos-inc/node';

let cached: WorkOS | null = null;

export function getWorkOS(): WorkOS {
  if (cached) return cached;
  const apiKey = process.env.WORKOS_API_KEY;
  if (!apiKey) {
    throw new Error('WORKOS_API_KEY is not configured');
  }
  cached = new WorkOS(apiKey);
  return cached;
}

export type VerifiedEvent = {
  id: string;
  event: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export type VerifyResult =
  | { ok: true; event: VerifiedEvent }
  | { ok: false; reason: string };

/**
 * Verify a WorkOS webhook payload.
 *
 * rawBody must be the unmodified request body string — the HMAC is computed
 * over the byte stream, so any reserialization breaks it.
 */
export function verifyWorkOSSignature(
  rawBody: string,
  signatureHeader: string | null,
  toleranceMs = 5 * 60_000,
): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' };
  const secret = process.env.WORKOS_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: 'webhook_secret_not_configured' };
  try {
    const workos = getWorkOS();
    const event = workos.webhooks.constructEvent({
      payload: JSON.parse(rawBody),
      sigHeader: signatureHeader,
      secret,
      tolerance: toleranceMs,
    }) as VerifiedEvent;
    return { ok: true, event };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown_error';
    return { ok: false, reason };
  }
}

/**
 * Test-only override: inject a stub WorkOS client (used by webhook +
 * setup route tests). Reset to null in afterEach.
 */
export function __setWorkOSForTesting(stub: WorkOS | null): void {
  cached = stub;
}
