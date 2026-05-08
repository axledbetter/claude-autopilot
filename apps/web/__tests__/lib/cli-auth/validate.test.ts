// Phase 4 — Spec tests 11-13: cli-auth validation gates.
//
// validateCallbackUrl is reused from Phase 2.3 (apps/web/lib/dashboard/callback-url.ts).
// The /cli-auth Server Component MUST call this BEFORE rendering anything
// interactive — codex CRITICAL #1 anchor for the Server Component flow.

import { describe, it, expect } from 'vitest';
import { validateCallbackUrl } from '@/lib/dashboard/callback-url';

const NONCE_RE = /^[0-9a-f]{32}$/;

describe('cli-auth validation', () => {
  it('test 11: validateCallbackUrl is accessible from /cli-auth', () => {
    // Smoke check — the helper exists and is callable from this module
    // path. Phase 2.3 placed it under @/lib/dashboard/callback-url; the
    // /cli-auth page imports it from there.
    expect(typeof validateCallbackUrl).toBe('function');
    expect(validateCallbackUrl('http://127.0.0.1:56000/cli-callback')).toBe(true);
  });

  it('test 12: nonce regex /^[0-9a-f]{32}$/ — valid + invalid cases', () => {
    expect(NONCE_RE.test('a'.repeat(32))).toBe(true);
    expect(NONCE_RE.test('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(NONCE_RE.test('A'.repeat(32))).toBe(false);  // uppercase rejected
    expect(NONCE_RE.test('a'.repeat(31))).toBe(false);  // too short
    expect(NONCE_RE.test('a'.repeat(33))).toBe(false);  // too long
    expect(NONCE_RE.test('zzzz' + 'a'.repeat(28))).toBe(false);  // non-hex
    expect(NONCE_RE.test('')).toBe(false);
  });

  it('test 13: server-side rejection on bad cb (page returns InvalidParams)', async () => {
    // The /cli-auth Server Component renders <InvalidParams> when
    // validateCallbackUrl returns false. We test the validator directly
    // here; the page-level integration is exercised in dashboard-pages.test.tsx.
    expect(validateCallbackUrl('http://attacker.example/cli-callback')).toBe(false);
    expect(validateCallbackUrl('http://127.0.0.1:80/cli-callback')).toBe(false);  // wrong port
    expect(validateCallbackUrl('https://127.0.0.1:56000/cli-callback')).toBe(false);  // wrong scheme
    expect(validateCallbackUrl('http://127.0.0.1:56000/evil')).toBe(false);  // wrong path
    expect(validateCallbackUrl(null)).toBe(false);
    expect(validateCallbackUrl(undefined)).toBe(false);
    expect(validateCallbackUrl(123)).toBe(false);
  });
});
