import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const { GET } = await import('@/app/api/dashboard/orgs/[orgId]/cost/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

function req(orgId: string, qs = ''): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/cost${qs ? `?${qs}` : ''}`);
}

function seedAdmin(orgId: string): { admin: string } {
  const admin = randomUUID();
  stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: admin, role: 'admin', status: 'active', joined_at: new Date().toISOString() }]);
  stub.seed('auth.users', [{ id: admin, email: 'admin@autopilot.dev' }]);
  return { admin };
}

function seedRuns(orgId: string, userId: string, runs: Partial<Record<string, unknown>>[]): void {
  const baseRun = (overrides: Record<string, unknown>) => ({
    id: randomUUID(),
    organization_id: orgId,
    user_id: userId,
    cost_usd: 0,
    duration_ms: 0,
    total_bytes: 0,
    deleted_at: null,
    created_at: '2026-04-15T12:00:00Z',
    ...overrides,
  });
  stub.seed('runs', runs.map(baseRun));
}

describe('GET /api/dashboard/orgs/:orgId/cost', () => {
  it('test 12: admin GET current month → 200 with rows + totals', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    seedRuns(orgId, admin, [
      { cost_usd: 1.5, duration_ms: 100, total_bytes: 1000, created_at: '2026-04-15T12:00:00Z' },
      { cost_usd: 2.5, duration_ms: 200, total_bytes: 2000, created_at: '2026-04-15T13:00:00Z' },
    ]);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-04&until=2026-04'), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.rows.length).toBe(1);
    expect(body.rows[0].run_count).toBe(2);
    expect(body.rows[0].cost_usd_sum).toBe(4);
    expect(body.total.run_count).toBe(2);
    expect(body.period.since).toBe('2026-04');
    expect(body.period.until).toBe('2026-04');
    expect(body.period.sinceTs).toBe('2026-04-01T00:00:00.000Z');
    expect(body.period.untilTs).toBe('2026-05-01T00:00:00.000Z');
  });

  it('test 12b: default period when no params → current UTC month', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    seedRuns(orgId, admin, [{ cost_usd: 1, created_at: '2026-04-10T00:00:00Z' }]);
    currentUser = { id: admin };
    const r = await GET(req(orgId), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.period.since).toBe('2026-04');
    expect(body.rows[0].cost_usd_sum).toBe(1);
  });

  it('test 13: member → 404', async () => {
    const orgId = randomUUID();
    const me = randomUUID();
    stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: me, role: 'member', status: 'active', joined_at: new Date().toISOString() }]);
    currentUser = { id: me };
    const r = await GET(req(orgId, 'since=2026-04&until=2026-04'), { params: { orgId } });
    expect(r.status).toBe(404);
  });

  it('test 14: malformed YYYY-MM → 422 bad_period', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-13&until=2026-04'), { params: { orgId } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('bad_period');
  });

  it('test 14b: since > until → 422 bad_period', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-05&until=2026-04'), { params: { orgId } });
    expect(r.status).toBe(422);
  });

  it('test 16: deleted_at runs excluded', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    seedRuns(orgId, admin, [
      { cost_usd: 1, created_at: '2026-04-10T00:00:00Z' },
      { cost_usd: 100, deleted_at: '2026-04-11T00:00:00Z', created_at: '2026-04-11T00:00:00Z' },
    ]);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-04&until=2026-04'), { params: { orgId } });
    const body = await r.json();
    expect(body.rows[0].cost_usd_sum).toBe(1);
    expect(body.total.cost_usd_sum).toBe(1);
  });

  it('test 17: cost_usd NULL treated as 0; deleted user → email null', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    const ghost = randomUUID();
    seedRuns(orgId, ghost, [{ cost_usd: null, duration_ms: null, total_bytes: null, created_at: '2026-04-15T00:00:00Z' }]);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-04&until=2026-04'), { params: { orgId } });
    const body = await r.json();
    expect(body.rows.length).toBe(1);
    expect(body.rows[0].user_id).toBe(ghost);
    expect(body.rows[0].email).toBeNull();
    expect(body.rows[0].cost_usd_sum).toBe(0);
  });

  it('codex-pr WARNING: groupBy=repo → 422 bad_group_by route-side', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-04&until=2026-04&groupBy=repo'), { params: { orgId } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('bad_group_by');
  });

  it('test 18: empty period → 200 rows: [], total all zeros', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-03&until=2026-03'), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.rows).toEqual([]);
    expect(body.total.run_count).toBe(0);
    expect(body.total.cost_usd_sum).toBe(0);
  });
});
