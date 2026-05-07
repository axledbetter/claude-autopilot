import { describe, it, expect, vi, beforeEach } from 'vitest';

const signOut = vi.fn();
const cookieStore = {
  getAll: vi.fn(() => [
    { name: 'sb-myproject-auth-token', value: 'session-data', options: { path: '/' } },
    { name: 'sb-myproject-auth-token.0', value: 'chunk-0', options: { path: '/' } },
    { name: 'sb-other-project-auth-token', value: 'other', options: { path: '/' } },
    { name: 'unrelated-cookie', value: 'keep', options: { path: '/' } },
  ]),
  delete: vi.fn(),
  set: vi.fn(),
};

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { signOut } }),
}));

vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

import { POST } from '@/app/api/auth/sign-out/route';

describe('POST /api/auth/sign-out', () => {
  beforeEach(() => {
    signOut.mockReset();
    cookieStore.delete.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
    process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF = 'myproject';
  });

  it('signs out + deletes only configured-project cookies + redirects to /', async () => {
    signOut.mockResolvedValueOnce({ error: null });
    const req = new Request('https://example.com/api/auth/sign-out', { method: 'POST' });
    const res = await POST(req);
    expect(signOut).toHaveBeenCalledOnce();
    // Configured project cookies deleted (auth-token + chunked variants).
    const deletedNames = cookieStore.delete.mock.calls.map(c => c[0]);
    expect(deletedNames).toContain('sb-myproject-auth-token');
    expect(deletedNames).toContain('sb-myproject-auth-token.0');
    // Other project's cookies and unrelated cookies are NOT touched.
    expect(deletedNames).not.toContain('sb-other-project-auth-token');
    expect(deletedNames).not.toContain('unrelated-cookie');
    // 303 See Other → GET / on browser follow.
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://example.com/');
  });

  it('idempotent — second sign-out call does not crash', async () => {
    signOut.mockResolvedValueOnce({ error: null });
    const req = new Request('https://example.com/api/auth/sign-out', { method: 'POST' });
    const res1 = await POST(req);
    expect(res1.status).toBe(303);

    signOut.mockResolvedValueOnce({ error: null });
    const res2 = await POST(req);
    expect(res2.status).toBe(303);
  });
});
