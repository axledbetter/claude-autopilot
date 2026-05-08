import { describe, it, expect } from 'vitest';
import { safeRedirect } from '@/lib/auth/redirect';

describe('safeRedirect', () => {
  it('returns / when next is null', () => {
    expect(safeRedirect(null)).toBe('/');
  });

  it('returns / when next is undefined', () => {
    expect(safeRedirect(undefined)).toBe('/');
  });

  it('returns / when next is empty string', () => {
    expect(safeRedirect('')).toBe('/');
  });

  it('returns the path for a valid allowlisted path', () => {
    expect(safeRedirect('/dashboard')).toBe('/dashboard');
    expect(safeRedirect('/runs/01HQK8')).toBe('/runs/01HQK8');
    expect(safeRedirect('/settings/billing')).toBe('/settings/billing');
  });

  it('rejects scheme-relative URLs (//evil.com)', () => {
    expect(safeRedirect('//evil.com')).toBe('/');
    expect(safeRedirect('//attacker.example/path')).toBe('/');
  });

  it('rejects absolute URLs (https://attacker.com)', () => {
    expect(safeRedirect('https://attacker.com')).toBe('/');
    expect(safeRedirect('http://evil.com/path')).toBe('/');
  });

  it('rejects unknown paths not in the allowlist', () => {
    expect(safeRedirect('/admin')).toBe('/');
    expect(safeRedirect('/internal/secrets')).toBe('/');
  });

  it('rejects URL-encoded scheme-relative attacks', () => {
    expect(safeRedirect('%2F%2Fevil.com')).toBe('/');
    expect(safeRedirect('%2f%2fevil.com')).toBe('/');
  });

  it('strips leading/trailing whitespace before validation', () => {
    expect(safeRedirect('  /dashboard  ')).toBe('/dashboard');
    expect(safeRedirect('  //evil.com  ')).toBe('/');
  });

  it('rejects malformed percent-encoding gracefully', () => {
    expect(safeRedirect('%E0%A4%A')).toBe('/');  // truncated UTF-8 escape
  });

  // Phase 4 — /cli-auth allowlist + query preservation.
  it('accepts /cli-auth with cb + nonce query (already-decoded form)', () => {
    const cb = 'http://127.0.0.1:56010/cli-callback';
    const nonce = 'a'.repeat(32);
    const path = `/cli-auth?cb=${cb}&nonce=${nonce}`;
    // Decoded form passes through unchanged.
    expect(safeRedirect(path)).toBe(path);
    expect(safeRedirect(path)).toContain(cb);
    expect(safeRedirect(path)).toContain(nonce);
  });

  it('preserves /cli-auth query string through encoded round-trip', () => {
    const cb = 'http://127.0.0.1:56010/cli-callback';
    const nonce = 'b'.repeat(32);
    // Simulate a parent URL ?next=<encoded /cli-auth?cb=...&nonce=...>.
    // safeRedirect's normalize step decodes once; the result must still
    // carry both params after Supabase OAuth round-trip.
    const cliAuthQuery = new URLSearchParams({ cb, nonce }).toString();
    const next = `/cli-auth?${cliAuthQuery}`;
    const encoded = encodeURIComponent(next);
    const result = safeRedirect(encoded);
    // Result is the once-decoded form. The cb param value remains
    // percent-encoded (URLSearchParams encoded it once); a downstream
    // URLSearchParams parse on result will decode it. Both forms verify
    // that the params survived the round-trip.
    expect(result.startsWith('/cli-auth')).toBe(true);
    expect(result).toBe(next);
    const params = new URLSearchParams(result.slice('/cli-auth?'.length));
    expect(params.get('cb')).toBe(cb);
    expect(params.get('nonce')).toBe(nonce);
  });
});
