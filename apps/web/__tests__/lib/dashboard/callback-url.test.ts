import { describe, it, expect } from 'vitest';
import { validateCallbackUrl } from '@/lib/dashboard/callback-url';

describe('validateCallbackUrl', () => {
  it('accepts loopback IPv4 in port range', () => {
    expect(validateCallbackUrl('http://127.0.0.1:56000/cli-callback')).toBe(true);
    expect(validateCallbackUrl('http://127.0.0.1:56050/cli-callback')).toBe(true);
    expect(validateCallbackUrl('http://localhost:56025/cli-callback')).toBe(true);
  });

  it('rejects out-of-range ports', () => {
    expect(validateCallbackUrl('http://127.0.0.1:55999/cli-callback')).toBe(false);
    expect(validateCallbackUrl('http://127.0.0.1:56051/cli-callback')).toBe(false);
    expect(validateCallbackUrl('http://127.0.0.1:80/cli-callback')).toBe(false);
  });

  it('rejects non-loopback hosts', () => {
    expect(validateCallbackUrl('http://attacker.example/cli-callback')).toBe(false);
    expect(validateCallbackUrl('http://192.168.1.5:56010/cli-callback')).toBe(false);
    expect(validateCallbackUrl('http://[::1]:56010/cli-callback')).toBe(false);
  });

  it('rejects HTTPS, credentials, query strings, wrong path', () => {
    expect(validateCallbackUrl('https://127.0.0.1:56010/cli-callback')).toBe(false);
    expect(validateCallbackUrl('http://user:pass@127.0.0.1:56010/cli-callback')).toBe(false);
    expect(validateCallbackUrl('http://127.0.0.1:56010/cli-callback?evil=1')).toBe(false);
    expect(validateCallbackUrl('http://127.0.0.1:56010/wrong')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(validateCallbackUrl('not a url')).toBe(false);
    expect(validateCallbackUrl('')).toBe(false);
    expect(validateCallbackUrl(null as unknown as string)).toBe(false);
  });
});
