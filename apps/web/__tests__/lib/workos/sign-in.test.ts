import { describe, it, expect, beforeEach, vi } from 'vitest';

const getAuthorizationUrlMock = vi.fn();
class FakeWorkOS {
  sso = { getAuthorizationUrl: getAuthorizationUrlMock };
  webhooks = { constructEvent: vi.fn() };
  organizations = {};
  adminPortal = {};
}
vi.mock('@workos-inc/node', () => ({ WorkOS: FakeWorkOS }));

beforeEach(() => {
  vi.resetModules();
  getAuthorizationUrlMock.mockReset();
  delete process.env.SSO_STATE_SIGNING_SECRET;
  delete process.env.WORKOS_API_KEY;
});

describe('sign-in helper', () => {
  it('signStateCookie + parseStateCookie round-trip', async () => {
    process.env.SSO_STATE_SIGNING_SECRET = 'z'.repeat(32);  // 'z' not hex → utf8 → 32 bytes
    const mod = await import('@/lib/workos/sign-in');
    const secret = mod.getSsoStateSigningSecret();
    const signed = mod.signStateCookie({ stateId: 'abc', nonce: 'def' }, secret);
    const parsed = mod.parseStateCookie(signed, secret);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.payload).toEqual({ stateId: 'abc', nonce: 'def' });
  });

  it('parseStateCookie rejects tampered signature', async () => {
    process.env.SSO_STATE_SIGNING_SECRET = 'z'.repeat(32);  // 'z' not hex → utf8 → 32 bytes
    const mod = await import('@/lib/workos/sign-in');
    const secret = mod.getSsoStateSigningSecret();
    const signed = mod.signStateCookie({ stateId: 'abc', nonce: 'def' }, secret);
    const tampered = `${signed.slice(0, -2)}xx`;
    const r = mod.parseStateCookie(tampered, secret);
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('parseStateCookie rejects missing cookie', async () => {
    process.env.SSO_STATE_SIGNING_SECRET = 'z'.repeat(32);  // 'z' not hex → utf8 → 32 bytes
    const mod = await import('@/lib/workos/sign-in');
    expect(mod.parseStateCookie(undefined, mod.getSsoStateSigningSecret())).toEqual({ ok: false, reason: 'missing' });
  });

  it('parseStateCookie rejects malformed (no dot)', async () => {
    process.env.SSO_STATE_SIGNING_SECRET = 'z'.repeat(32);  // 'z' not hex → utf8 → 32 bytes
    const mod = await import('@/lib/workos/sign-in');
    expect(mod.parseStateCookie('not-a-cookie', mod.getSsoStateSigningSecret()).ok).toBe(false);
  });

  it('parseStateCookie rejects with wrong secret', async () => {
    process.env.SSO_STATE_SIGNING_SECRET = 'z'.repeat(32);  // 'z' not hex → utf8 → 32 bytes
    const mod = await import('@/lib/workos/sign-in');
    const secret = mod.getSsoStateSigningSecret();
    const signed = mod.signStateCookie({ stateId: 'abc', nonce: 'def' }, secret);
    const wrongSecret = Buffer.from('b'.repeat(32), 'utf8');
    expect(mod.parseStateCookie(signed, wrongSecret)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('parseStateCookie rejects malformed payload (missing fields)', async () => {
    process.env.SSO_STATE_SIGNING_SECRET = 'z'.repeat(32);  // 'z' not hex → utf8 → 32 bytes
    const mod = await import('@/lib/workos/sign-in');
    const secret = mod.getSsoStateSigningSecret();
    const b64 = Buffer.from(JSON.stringify({ stateId: 'abc' }), 'utf8').toString('base64url');
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', secret).update(b64).digest('base64url');
    const r = mod.parseStateCookie(`${b64}.${sig}`, secret);
    expect(r).toEqual({ ok: false, reason: 'malformed_payload' });
  });

  it('getSsoStateSigningSecret throws when env unset', async () => {
    const mod = await import('@/lib/workos/sign-in');
    expect(() => mod.getSsoStateSigningSecret()).toThrow('SSO_STATE_SIGNING_SECRET');
  });

  it('getSsoStateSigningSecret throws when secret too short', async () => {
    process.env.SSO_STATE_SIGNING_SECRET = 'z'.repeat(31);  // 31 bytes utf8
    const mod = await import('@/lib/workos/sign-in');
    expect(() => mod.getSsoStateSigningSecret()).toThrow(/at least 32 bytes/);
  });

  it('parseStateCookie rejects with wrong secret (different bytes)', async () => {
    process.env.SSO_STATE_SIGNING_SECRET = 'z'.repeat(32);
    const mod = await import('@/lib/workos/sign-in');
    const secret = mod.getSsoStateSigningSecret();
    const signed = mod.signStateCookie({ stateId: 'abc', nonce: 'def' }, secret);
    const wrongSecret = Buffer.from('y'.repeat(32), 'utf8');
    expect(mod.parseStateCookie(signed, wrongSecret)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('getSsoStateSigningSecret accepts a 32-byte hex string (64 hex chars = 32 bytes)', async () => {
    process.env.SSO_STATE_SIGNING_SECRET = '0'.repeat(64);
    const mod = await import('@/lib/workos/sign-in');
    expect(mod.getSsoStateSigningSecret().length).toBe(32);
  });

  it('buildAuthorizeUrl passes clientId, connection, state, redirectUri to SDK', async () => {
    process.env.WORKOS_API_KEY = 'sk_test';
    getAuthorizationUrlMock.mockReturnValue('https://api.workos.com/sso/authorize?stub=1');
    const mod = await import('@/lib/workos/sign-in');
    const url = mod.buildAuthorizeUrl({
      workosConnectionId: 'conn_x',
      stateId: 'st_y',
      redirectUri: 'https://app/callback',
      clientId: 'client_z',
    });
    expect(url).toBe('https://api.workos.com/sso/authorize?stub=1');
    expect(getAuthorizationUrlMock).toHaveBeenCalledWith({
      connection: 'conn_x',
      clientId: 'client_z',
      state: 'st_y',
      redirectUri: 'https://app/callback',
    });
  });
});
