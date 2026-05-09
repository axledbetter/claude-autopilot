// apps/web/__tests__/lib/middleware/cookie-hmac.test.ts
//
// v7.0 Phase 6 — spec test #11.
// (a) sign/verify roundtrip
// (b) tamper detection (signature mismatch)
// (c) expiry rejection
// (d) constant-time compare via timingSafeEqual
// (e) lazy secret validation throws cookie_secret_missing on first call
//     when MEMBERSHIP_CHECK_COOKIE_SECRET is unset (codex pass-2 WARNING #3)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getMembershipCheckSecret,
  signMembershipCookie,
  verifyMembershipCookie,
  type MembershipCookiePayload,
} from '@/lib/middleware/cookie-hmac';
import { MembershipCheckError } from '@/lib/supabase/check-membership';

const SECRET = 'a'.repeat(64); // 64 bytes — well over 32-byte minimum
const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = '99999999-8888-7777-6666-555555555555';

function makePayload(overrides: Partial<MembershipCookiePayload> = {}): MembershipCookiePayload {
  return {
    orgId: ORG_ID,
    userId: USER_ID,
    status: 'active',
    role: 'member',
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

describe('cookie-hmac', () => {
  beforeEach(() => {
    process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.MEMBERSHIP_CHECK_COOKIE_SECRET;
  });

  describe('test #11(a) — sign/verify roundtrip', () => {
    it('signs a payload and verifies it back', () => {
      const payload = makePayload();
      const signed = signMembershipCookie(payload);
      expect(signed).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const result = verifyMembershipCookie(signed);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.orgId).toBe(payload.orgId);
        expect(result.payload.userId).toBe(payload.userId);
        expect(result.payload.role).toBe(payload.role);
        expect(result.payload.exp).toBe(payload.exp);
      }
    });

    it('roundtrips for owner / admin / member roles', () => {
      for (const role of ['owner', 'admin', 'member'] as const) {
        const signed = signMembershipCookie(makePayload({ role }));
        const result = verifyMembershipCookie(signed);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.payload.role).toBe(role);
      }
    });
  });

  describe('test #11(b) — tamper detection', () => {
    it('rejects a payload with a flipped signature', () => {
      const signed = signMembershipCookie(makePayload());
      const tampered = signed.slice(0, -2) + (signed.endsWith('aa') ? 'bb' : 'aa');
      const result = verifyMembershipCookie(tampered);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('bad_signature');
    });

    it('rejects a payload with mutated body but same signature', () => {
      const signed = signMembershipCookie(makePayload());
      // Replace payload portion with garbage; signature won't match.
      const idx = signed.indexOf('.');
      const tampered = 'garbagepayload.' + signed.slice(idx + 1);
      const result = verifyMembershipCookie(tampered);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['bad_signature', 'malformed']).toContain(result.reason);
    });

    it('rejects an unsigned cookie (no dot separator)', () => {
      const result = verifyMembershipCookie('justplaintext');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('malformed');
    });

    it('rejects an empty cookie', () => {
      const result = verifyMembershipCookie('');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('malformed');
    });

    it('rejects undefined cookie', () => {
      const result = verifyMembershipCookie(undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('malformed');
    });
  });

  describe('test #11(c) — expiry rejection', () => {
    it('rejects an expired payload', () => {
      const past = Math.floor(Date.now() / 1000) - 1;
      const signed = signMembershipCookie(makePayload({ exp: past }));
      const result = verifyMembershipCookie(signed);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('expired');
    });

    it('accepts a payload with exp exactly 1s in the future', () => {
      const future = Math.floor(Date.now() / 1000) + 1;
      const signed = signMembershipCookie(makePayload({ exp: future }));
      const result = verifyMembershipCookie(signed);
      expect(result.ok).toBe(true);
    });

    it('uses the supplied nowSeconds parameter for time-travel tests', () => {
      const exp = Math.floor(Date.now() / 1000) + 60;
      const signed = signMembershipCookie(makePayload({ exp }));
      // Advance "now" past exp — should reject.
      const result = verifyMembershipCookie(signed, exp + 1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('expired');
    });
  });

  describe('test #11(d) — constant-time compare', () => {
    it('uses timingSafeEqual (smoke check via length-mismatch path)', () => {
      // A length-mismatched signature is rejected before timingSafeEqual
      // even runs (timingSafeEqual throws on length mismatch). We rely on
      // the explicit length check inside verifyMembershipCookie. Verify
      // the rejection categorizes as bad_signature.
      const signed = signMembershipCookie(makePayload());
      const idx = signed.indexOf('.');
      // Truncate signature to make it shorter than the expected HMAC.
      const tampered = signed.slice(0, idx) + '.' + signed.slice(idx + 1, idx + 5);
      const result = verifyMembershipCookie(tampered);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['bad_signature', 'malformed']).toContain(result.reason);
    });
  });

  describe('test #11(e) — lazy secret validation', () => {
    it('throws cookie_secret_missing on first call when env unset', () => {
      delete process.env.MEMBERSHIP_CHECK_COOKIE_SECRET;
      try {
        getMembershipCheckSecret();
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipCheckError);
        expect((err as MembershipCheckError).code).toBe('cookie_secret_missing');
      }
    });

    it('throws cookie_secret_missing when secret is too short', () => {
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = 'short';
      try {
        getMembershipCheckSecret();
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipCheckError);
        expect((err as MembershipCheckError).code).toBe('cookie_secret_missing');
        expect((err as MembershipCheckError).subcode).toBe('too_short');
      }
    });

    it('returns the secret when valid', () => {
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = SECRET;
      expect(getMembershipCheckSecret()).toBe(SECRET);
    });

    it('verify treats missing-secret as cache miss (returns malformed, not throw)', () => {
      delete process.env.MEMBERSHIP_CHECK_COOKIE_SECRET;
      const result = verifyMembershipCookie('any.cookie');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('malformed');
    });

    it('sign throws cookie_secret_missing when env unset (does NOT swallow)', () => {
      delete process.env.MEMBERSHIP_CHECK_COOKIE_SECRET;
      try {
        signMembershipCookie(makePayload());
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipCheckError);
        expect((err as MembershipCheckError).code).toBe('cookie_secret_missing');
      }
    });
  });

  // v7.1.1 — dual-secret rotation
  describe('v7.1.1 — MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS rotation', () => {
    const PREVIOUS = 'b'.repeat(64);

    beforeEach(() => {
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = SECRET;
      delete process.env.MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS;
    });
    afterEach(() => {
      delete process.env.MEMBERSHIP_CHECK_COOKIE_SECRET;
      delete process.env.MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS;
    });

    it('cookie signed with PREVIOUS verifies during rotation window', () => {
      // Sim: cookie was signed with the old secret, then operator
      // rotated. Old cookie still verifies via PREVIOUS fallback.
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = PREVIOUS;
      const oldCookie = signMembershipCookie(makePayload());
      // Now flip: CURRENT = new value, PREVIOUS = the old one used above.
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = SECRET;
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS = PREVIOUS;
      expect(verifyMembershipCookie(oldCookie).ok).toBe(true);
    });

    it('new cookies always sign with CURRENT (not PREVIOUS)', () => {
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS = PREVIOUS;
      const newCookie = signMembershipCookie(makePayload());
      // Verify under CURRENT-only env: should pass.
      delete process.env.MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS;
      expect(verifyMembershipCookie(newCookie).ok).toBe(true);
      // Swap CURRENT to junk with no PREVIOUS — verification fails.
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = 'z'.repeat(64);
      const result = verifyMembershipCookie(newCookie);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('bad_signature');
    });

    it('cookie signed with random third secret fails even with both CURRENT + PREVIOUS set', () => {
      const FORGED_SECRET = 'q'.repeat(64);
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = FORGED_SECRET;
      const forgedCookie = signMembershipCookie(makePayload());
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = SECRET;
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS = PREVIOUS;
      const result = verifyMembershipCookie(forgedCookie);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('bad_signature');
    });

    it('PREVIOUS unset → behaves identically to v7.1.0 (single-secret)', () => {
      const cookie = signMembershipCookie(makePayload());
      // PREVIOUS deliberately not set.
      expect(verifyMembershipCookie(cookie).ok).toBe(true);
      // Cookie signed under a different secret with no PREVIOUS fallback:
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = 'z'.repeat(64);
      expect(verifyMembershipCookie(cookie).ok).toBe(false);
    });

    it('PREVIOUS set but too short → ignored (warn-once), CURRENT still works', async () => {
      const { _resetPreviousSecretWarnLatchForTests } = await import('@/lib/middleware/cookie-hmac');
      _resetPreviousSecretWarnLatchForTests();
      process.env.MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS = 'short'; // < 32 bytes
      const cookie = signMembershipCookie(makePayload());
      // Cookie signed with CURRENT verifies fine; PREVIOUS being malformed
      // doesn't break the happy path.
      expect(verifyMembershipCookie(cookie).ok).toBe(true);
    });
  });
});
