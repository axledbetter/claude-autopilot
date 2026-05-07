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
});
