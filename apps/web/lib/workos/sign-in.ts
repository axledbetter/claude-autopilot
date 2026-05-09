// Phase 5.6 — SSO sign-in state cookie + authorize URL helpers.
//
// State protocol (codex spec pass-2 CRITICAL #2):
//   - generate stateId (UUID) + nonce (32-byte hex)
//   - DB row stores nonce_hash = sha256(nonce)
//   - cookie holds HMAC-signed { stateId, nonce }
//   - WorkOS state query param = stateId only
//   - callback parses cookie → verifies HMAC → consume_sso_authentication_state
//     RPC validates by (stateId, sha256(nonce)) + workos org/connection match.
//
// Cookie format: `<base64url(json)>.<base64url(hmacSha256)>`.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getWorkOS } from '@/lib/workos/client';

const MIN_SECRET_BYTES = 32;
let cachedSecret: Buffer | null = null;

export function getSsoStateSigningSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const raw = process.env.SSO_STATE_SIGNING_SECRET;
  if (!raw) throw new Error('SSO_STATE_SIGNING_SECRET is not configured');
  const buf = /^[0-9a-fA-F]+$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'utf8');
  if (buf.length < MIN_SECRET_BYTES) {
    throw new Error(
      `SSO_STATE_SIGNING_SECRET must be at least ${MIN_SECRET_BYTES} bytes (got ${buf.length})`,
    );
  }
  cachedSecret = buf;
  return cachedSecret;
}

export function __resetSsoStateSigningSecretForTests(): void {
  cachedSecret = null;
}

export interface StateCookiePayload {
  stateId: string;
  nonce: string;
}

export function signStateCookie(payload: StateCookiePayload, secret: Buffer): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

export type ParseResult =
  | { ok: true; payload: StateCookiePayload }
  | { ok: false; reason: string };

export function parseStateCookie(value: string | undefined, secret: Buffer): ParseResult {
  if (!value) return { ok: false, reason: 'missing' };
  const dot = value.lastIndexOf('.');
  if (dot < 1) return { ok: false, reason: 'malformed' };
  const b64 = value.slice(0, dot);
  const givenSig = value.slice(dot + 1);
  const expectSig = createHmac('sha256', secret).update(b64).digest('base64url');
  if (givenSig.length !== expectSig.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(Buffer.from(givenSig), Buffer.from(expectSig))) {
    return { ok: false, reason: 'bad_signature' };
  }
  try {
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { stateId?: unknown; nonce?: unknown };
    if (typeof payload.stateId !== 'string' || typeof payload.nonce !== 'string') {
      return { ok: false, reason: 'malformed_payload' };
    }
    return { ok: true, payload: { stateId: payload.stateId, nonce: payload.nonce } };
  } catch {
    return { ok: false, reason: 'malformed_payload' };
  }
}

export interface AuthorizeUrlArgs {
  workosConnectionId: string;
  stateId: string;
  redirectUri: string;
  clientId: string;
}

/**
 * Build the WorkOS authorize URL. Codex plan-pass CRITICAL #3 — clientId
 * is required by the SDK; pass it explicitly.
 */
export function buildAuthorizeUrl(args: AuthorizeUrlArgs): string {
  const workos = getWorkOS();
  return workos.sso.getAuthorizationUrl({
    connection: args.workosConnectionId,
    clientId: args.clientId,
    state: args.stateId,
    redirectUri: args.redirectUri,
  });
}
