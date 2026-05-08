// Phase 4 — Spec test 26: /cli-auth response carries the hardened
// security headers via middleware.ts (NOT via headers() in the Server
// Component, which only reads request headers — codex pass 2 WARNING #2).
//
// The connect-src exception for http://127.0.0.1:* and http://localhost:*
// is required for the loopback POST. Without exact CSP value, the
// browser fetch fails silently.
//
// Note: We can't easily run the full Next middleware function under jsdom
// because NextResponse.next({ request }) requires the request.headers to
// be Next's bundled Headers class (not jsdom's). Instead we assert on the
// exported constants the middleware applies + the path-detection helper.

import { describe, it, expect } from 'vitest';
import { CLI_AUTH_CSP, CLI_AUTH_HEADERS, isCliAuthPath } from '@/middleware';

describe('/cli-auth security headers (middleware constants)', () => {
  it('test 26: CSP includes exact loopback connect-src exception', () => {
    expect(CLI_AUTH_CSP).toContain("connect-src 'self' http://127.0.0.1:* http://localhost:*");
  });

  it('test 26: CSP locks down default-src and frame-ancestors', () => {
    expect(CLI_AUTH_CSP).toContain("default-src 'self'");
    expect(CLI_AUTH_CSP).toContain("frame-ancestors 'none'");
  });

  it('test 26: full header set covers Cache-Control, Referrer-Policy, X-Frame-Options', () => {
    expect(CLI_AUTH_HEADERS['Cache-Control']).toBe('no-store, no-cache, must-revalidate');
    expect(CLI_AUTH_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(CLI_AUTH_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(CLI_AUTH_HEADERS['Content-Security-Policy']).toBe(CLI_AUTH_CSP);
  });

  it('test 26: only /cli-auth and its subpaths get the hardened headers', () => {
    expect(isCliAuthPath('/cli-auth')).toBe(true);
    expect(isCliAuthPath('/cli-auth/')).toBe(true);
    expect(isCliAuthPath('/cli-auth/something')).toBe(true);
    expect(isCliAuthPath('/dashboard')).toBe(false);
    expect(isCliAuthPath('/')).toBe(false);
    expect(isCliAuthPath('/cli')).toBe(false);
    expect(isCliAuthPath('/cli-auth-other')).toBe(false);
  });
});
