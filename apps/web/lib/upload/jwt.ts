import jwt from 'jsonwebtoken';

const TTL_SECONDS = 15 * 60;            // 15 minutes
const SKEW_SECONDS = 60;                // ±60s clock skew
const AUD = 'claude-autopilot-upload';
const ISS = 'autopilot.dev';

export interface UploadTokenClaims {
  sub: string;          // user_id
  run_id: string;       // ULID
  /** Organization ID for org-scoped runs; null for personal/free-tier.
   *  This is the SOLE authority for membership-recheck dispatch
   *  (truthy → check). On the wire, personal runs serialize as the
   *  empty string for v7.0 compatibility; verify normalizes '' → null
   *  so consumers always see `string | null`. */
  org_id: string | null;
  jti: string;          // upload_sessions.jti
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  /** Observability-only snapshot of membership status at mint time.
   *  NOT used for authorization (codex pass-1 CRITICAL #2). Optional
   *  for forward-compat with v7.0 tokens during rollout. */
  mint_status?: 'active' | 'personal';
}

export interface MintInput {
  userId: string;
  runId: string;
  orgId: string | null;
  jti: string;
  /** Required as of v7.1 — embedded as the `mint_status` claim for
   *  observability/audit. Not consulted at verify time for authorization
   *  (codex pass-1 CRITICAL #2). */
  mintStatus: 'active' | 'personal';
}

function getSecret(): string {
  const s = process.env.UPLOAD_SESSION_JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('UPLOAD_SESSION_JWT_SECRET missing or too short (need >=32 chars)');
  }
  return s;
}

export function mintUploadToken(input: MintInput): { token: string; expiresAt: Date } {
  const now = Math.floor(Date.now() / 1000);
  // Wire format: keep org_id as '' for personal runs to match v7.0
  // token shape (verify normalizes back to null).
  const wireOrgId: string = input.orgId ?? '';
  const claims = {
    sub: input.userId,
    run_id: input.runId,
    org_id: wireOrgId,
    jti: input.jti,
    aud: AUD,
    iss: ISS,
    exp: now + TTL_SECONDS,
    iat: now,
    mint_status: input.mintStatus,
  };
  const token = jwt.sign(claims, getSecret(), { algorithm: 'HS256' });
  return { token, expiresAt: new Date(claims.exp * 1000) };
}

export type TokenErrorReason =
  | 'invalid'
  | 'expired'
  | 'missing_claim'
  | 'wrong_audience'
  | 'wrong_issuer';

export class TokenError extends Error {
  public readonly reason: TokenErrorReason;
  constructor(reason: TokenErrorReason) {
    super(`token error: ${reason}`);
    this.reason = reason;
  }
}

/**
 * @internal Use `verifyTokenAndAssertRunMembership()` from
 * `@/lib/upload/auth` instead. This function is the bare JWT decode +
 * shape check; it does NOT enforce the per-request membership re-check
 * that v7.1 adds. ESLint `no-restricted-imports` rule on
 * `apps/web/app/api/runs/**` rejects direct imports of this module
 * outside of `lib/upload/auth.ts`.
 */
export function _verifyUploadTokenInternal(rawToken: string): UploadTokenClaims {
  let decoded: jwt.JwtPayload | string;
  try {
    decoded = jwt.verify(rawToken, getSecret(), {
      algorithms: ['HS256'],
      audience: AUD,
      issuer: ISS,
      clockTolerance: SKEW_SECONDS,
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'name' in err) {
      if ((err as { name: string }).name === 'TokenExpiredError') throw new TokenError('expired');
    }
    throw new TokenError('invalid');
  }
  if (typeof decoded === 'string') throw new TokenError('invalid');
  const required: (keyof UploadTokenClaims)[] = ['sub', 'run_id', 'org_id', 'jti', 'aud', 'iss', 'exp', 'iat'];
  for (const k of required) {
    if (!(k in decoded)) throw new TokenError('missing_claim');
  }
  // Normalize '' org_id → null so the helper's truthy check is the
  // single source of authority (codex pass-1 CRITICAL #3).
  const rawOrgId = decoded.org_id;
  const normalizedOrgId: string | null =
    typeof rawOrgId === 'string' && rawOrgId.length > 0 ? rawOrgId : null;
  return { ...decoded, org_id: normalizedOrgId } as UploadTokenClaims;
}

/**
 * @deprecated v7.1 — use `verifyTokenAndAssertRunMembership()` from
 * `@/lib/upload/auth` instead. Direct callers from `app/api/runs/**`
 * are blocked by the ESLint `no-restricted-imports` rule. This export
 * is preserved ONLY for the JWT-shape unit tests in
 * `__tests__/lib/jwt.test.ts`.
 */
export function verifyUploadToken(rawToken: string): UploadTokenClaims {
  return _verifyUploadTokenInternal(rawToken);
}
