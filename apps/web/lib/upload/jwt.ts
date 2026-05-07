import jwt from 'jsonwebtoken';

const TTL_SECONDS = 15 * 60;            // 15 minutes
const SKEW_SECONDS = 60;                // ±60s clock skew
const AUD = 'claude-autopilot-upload';
const ISS = 'autopilot.dev';

export interface UploadTokenClaims {
  sub: string;          // user_id
  run_id: string;       // ULID
  org_id: string;       // organization_id or '' for free-tier
  jti: string;          // upload_sessions.jti
  aud: string;
  iss: string;
  exp: number;
  iat: number;
}

export interface MintInput {
  userId: string;
  runId: string;
  orgId: string | null;
  jti: string;
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
  const claims: UploadTokenClaims = {
    sub: input.userId,
    run_id: input.runId,
    org_id: input.orgId ?? '',
    jti: input.jti,
    aud: AUD,
    iss: ISS,
    exp: now + TTL_SECONDS,
    iat: now,
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

export function verifyUploadToken(rawToken: string): UploadTokenClaims {
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
  return decoded as UploadTokenClaims;
}
