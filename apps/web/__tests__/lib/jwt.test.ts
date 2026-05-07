import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { mintUploadToken, verifyUploadToken, TokenError } from '@/lib/upload/jwt';

const SECRET = '0'.repeat(64);

beforeAll(() => { process.env.UPLOAD_SESSION_JWT_SECRET = SECRET; });
afterAll(() => { delete process.env.UPLOAD_SESSION_JWT_SECRET; });

describe('upload-token mint/verify', () => {
  const baseInput = { userId: 'u1', runId: 'r1', orgId: 'o1', jti: 'jti1' };

  it('mints a token with all required claims', () => {
    const { token, expiresAt } = mintUploadToken(baseInput);
    const claims = verifyUploadToken(token);
    expect(claims.sub).toBe('u1');
    expect(claims.run_id).toBe('r1');
    expect(claims.org_id).toBe('o1');
    expect(claims.jti).toBe('jti1');
    expect(claims.aud).toBe('claude-autopilot-upload');
    expect(claims.iss).toBe('autopilot.dev');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('encodes free-tier (null org) as empty string', () => {
    const { token } = mintUploadToken({ ...baseInput, orgId: null });
    const claims = verifyUploadToken(token);
    expect(claims.org_id).toBe('');
  });

  it('rejects token with wrong audience', () => {
    const bad = jwt.sign(
      { sub: 'u1', run_id: 'r1', org_id: 'o1', jti: 'j', aud: 'wrong', iss: 'autopilot.dev' },
      SECRET,
      { algorithm: 'HS256', expiresIn: '15m' },
    );
    expect(() => verifyUploadToken(bad)).toThrowError(TokenError);
  });

  it('rejects token signed with HS256 but wrong key', () => {
    const bad = jwt.sign({ sub: 'u1', aud: 'claude-autopilot-upload', iss: 'autopilot.dev' }, '1'.repeat(64), { algorithm: 'HS256', expiresIn: '15m' });
    expect(() => verifyUploadToken(bad)).toThrowError(TokenError);
  });

  it('rejects expired token (beyond clock skew tolerance)', () => {
    // jwt.verify allows ±60s clock skew, so -120s puts us safely past the
    // window. The TokenError reason 'expired' is encoded in the message.
    const expired = jwt.sign(
      { sub: 'u1', run_id: 'r1', org_id: 'o1', jti: 'j', aud: 'claude-autopilot-upload', iss: 'autopilot.dev' },
      SECRET,
      { algorithm: 'HS256', expiresIn: -120 },
    );
    expect(() => verifyUploadToken(expired)).toThrow(/expired/);
  });

  it('rejects token missing required claim', () => {
    const incomplete = jwt.sign(
      { sub: 'u1', aud: 'claude-autopilot-upload', iss: 'autopilot.dev' },
      SECRET,
      { algorithm: 'HS256', expiresIn: '15m' },
    );
    expect(() => verifyUploadToken(incomplete)).toThrowError(TokenError);
  });
});
