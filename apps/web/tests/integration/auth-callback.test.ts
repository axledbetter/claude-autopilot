import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @supabase/ssr BEFORE importing the route handler.
const exchangeCodeForSession = vi.fn();
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession,
    },
  }),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

import { GET } from '@/app/api/auth/callback/route';

describe('GET /api/auth/callback', () => {
  beforeEach(() => {
    exchangeCodeForSession.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  });

  it('valid code → exchange + redirect to safeRedirect(next)', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({ data: { session: { access_token: 'a' } }, error: null });
    const req = new Request('https://example.com/api/auth/callback?code=valid&next=/dashboard');
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://example.com/dashboard');
    expect(exchangeCodeForSession).toHaveBeenCalledWith('valid');
  });

  it('missing code → redirect to / with auth_no_code error', async () => {
    const req = new Request('https://example.com/api/auth/callback?next=/dashboard');
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://example.com/?error=auth_no_code');
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('invalid code → exchange throws → redirect to / with auth_failed', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({ data: null, error: new Error('bad code') });
    const req = new Request('https://example.com/api/auth/callback?code=bad&next=/dashboard');
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://example.com/?error=auth_failed');
  });

  it('upstream provider error → pass through sanitized', async () => {
    const req = new Request('https://example.com/api/auth/callback?error=access_denied');
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://example.com/?error=access_denied');
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('malicious next=//evil.com → safeRedirect rejects → /', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({ data: { session: {} }, error: null });
    const req = new Request('https://example.com/api/auth/callback?code=valid&next=//evil.com');
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://example.com/');
  });
});
