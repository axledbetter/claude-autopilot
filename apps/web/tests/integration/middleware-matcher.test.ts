import { describe, it, expect } from 'vitest';
import { config } from '@/middleware';

// The Next.js matcher syntax accepts an array of regex-flavoured strings.
// We compile them locally and assert behavior.
function matches(matcher: string[], path: string): boolean {
  return matcher.some(m => {
    // Strip leading '/' and convert to a regex anchored at start.
    const pattern = m.startsWith('/') ? m.slice(1) : m;
    return new RegExp(`^/${pattern}$`).test(path) || new RegExp(`^/${pattern}`).test(path);
  });
}

describe('middleware config.matcher', () => {
  const matcher = config.matcher as string[];

  it('matches page paths', () => {
    expect(matches(matcher, '/')).toBe(true);
    expect(matches(matcher, '/dashboard')).toBe(true);
    expect(matches(matcher, '/runs/01HQK8')).toBe(true);
  });

  it('matches /api/auth/* (session refresh needed for callback + signout)', () => {
    expect(matches(matcher, '/api/auth/callback')).toBe(true);
    expect(matches(matcher, '/api/auth/sign-out')).toBe(true);
  });

  it('excludes static asset paths', () => {
    expect(matches(matcher, '/_next/static/abc.js')).toBe(false);
    expect(matches(matcher, '/_next/image?url=foo')).toBe(false);
    expect(matches(matcher, '/favicon.ico')).toBe(false);
    expect(matches(matcher, '/logo.svg')).toBe(false);
    expect(matches(matcher, '/hero.png')).toBe(false);
  });

  it('excludes /api/health and non-auth /api/* (ingest endpoints in 2.2)', () => {
    expect(matches(matcher, '/api/health')).toBe(false);
    expect(matches(matcher, '/api/upload-session')).toBe(false);
    expect(matches(matcher, '/api/runs/01HQK8/events/0')).toBe(false);
  });
});
