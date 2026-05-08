import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const { GET } = await import('@/app/api/dashboard/orgs/[orgId]/cost.csv/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
});

function req(orgId: string, qs = ''): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/cost.csv${qs ? `?${qs}` : ''}`);
}

function seedAdminWithCosts(orgId: string, runs: Partial<Record<string, unknown>>[], userEmail = 'admin@autopilot.dev'): { admin: string } {
  const admin = randomUUID();
  stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: admin, role: 'admin', status: 'active', joined_at: new Date().toISOString() }]);
  stub.seed('auth.users', [{ id: admin, email: userEmail }]);
  stub.seed('runs', runs.map((r) => ({
    id: randomUUID(),
    organization_id: orgId,
    user_id: admin,
    cost_usd: 0,
    duration_ms: 0,
    total_bytes: 0,
    deleted_at: null,
    created_at: '2026-04-15T12:00:00Z',
    ...r,
  })));
  return { admin };
}

describe('GET /api/dashboard/orgs/:orgId/cost.csv', () => {
  it('test 19: admin GET → 200 + headers', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdminWithCosts(orgId, [{ cost_usd: 1.5, total_bytes: 100, duration_ms: 500 }]);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-04&until=2026-04'), { params: { orgId } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const cd = r.headers.get('content-disposition');
    expect(cd).toMatch(/^attachment; filename="cost-/);
  });

  it('test 19b: filename header value has no quotes/CR/LF/semicolons (codex CRITICAL)', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdminWithCosts(orgId, [{ cost_usd: 1 }]);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-04&until=2026-04'), { params: { orgId } });
    const cd = r.headers.get('content-disposition')!;
    const m = /filename="([^"]+)"/.exec(cd);
    expect(m).not.toBeNull();
    const filename = m![1];
    expect(filename).not.toMatch(/["\r\n;]/);
    expect(filename).toMatch(/^cost-[0-9a-f-]{36}-\d{4}-\d{2}-\d{4}-\d{2}\.csv$/);
  });

  it('test 20: CSV escaping — comma + quote + newline in email; CRLF terminator', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdminWithCosts(orgId, [{ cost_usd: 1 }], 'foo,"bar"\nbaz@example.com');
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-04&until=2026-04'), { params: { orgId } });
    const text = await r.text();
    expect(text.split('\r\n')[0]).toBe('user_id,email,run_count,cost_usd_sum,duration_ms_sum,total_bytes_sum');
    expect(text).toContain('"foo,""bar""\nbaz@example.com"');
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('test 21: non-admin → 404', async () => {
    const orgId = randomUUID();
    const me = randomUUID();
    stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: me, role: 'member', status: 'active', joined_at: new Date().toISOString() }]);
    currentUser = { id: me };
    const r = await GET(req(orgId, 'since=2026-04&until=2026-04'), { params: { orgId } });
    expect(r.status).toBe(404);
  });

  it('test 22: column order matches spec', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdminWithCosts(orgId, [{ cost_usd: 1, duration_ms: 50, total_bytes: 100 }]);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-04&until=2026-04'), { params: { orgId } });
    const text = await r.text();
    expect(text.split('\r\n')[0]).toBe('user_id,email,run_count,cost_usd_sum,duration_ms_sum,total_bytes_sum');
  });
});
