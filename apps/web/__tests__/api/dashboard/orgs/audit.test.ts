import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

const { GET } = await import('@/app/api/dashboard/orgs/[orgId]/audit/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
});

function req(orgId: string, qs = ''): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/audit${qs ? `?${qs}` : ''}`);
}

function seedAdmin(orgId: string): { admin: string } {
  const admin = randomUUID();
  stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: admin, role: 'admin', status: 'active', joined_at: new Date().toISOString() }]);
  stub.seed('auth.users', [{ id: admin, email: 'admin@autopilot.dev' }]);
  return { admin };
}

function seedEvents(orgId: string, count: number, baseTs = '2026-04-15T12:00:00Z'): void {
  const events = [];
  for (let i = 0; i < count; i++) {
    const t = new Date(new Date(baseTs).getTime() - i * 60_000);
    events.push({
      id: 1000 + i,
      organization_id: orgId,
      action: 'org.member.invited',
      actor_user_id: null,
      subject_type: 'membership',
      subject_id: randomUUID(),
      metadata: { i },
      occurred_at: t.toISOString(),
      prev_hash: null,
      this_hash: `hash-${i}`,
    });
  }
  stub.seed('audit_events', events);
}

describe('GET /api/dashboard/orgs/:orgId/audit', () => {
  it('test 1: admin GET → 200 with events, nextCursor null when < limit', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    seedEvents(orgId, 3);
    currentUser = { id: admin };
    const r = await GET(req(orgId), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.events.length).toBe(3);
    expect(body.nextCursor).toBeNull();
  });

  it('test 2: member → 404', async () => {
    const orgId = randomUUID();
    const me = randomUUID();
    stub.seed('memberships', [{ id: randomUUID(), organization_id: orgId, user_id: me, role: 'member', status: 'active', joined_at: new Date().toISOString() }]);
    currentUser = { id: me };
    const r = await GET(req(orgId), { params: { orgId } });
    expect(r.status).toBe(404);
  });

  it('test 3: non-member → 403 no_membership (v7.5.0 helper short-circuits)', async () => {
    // Pre-v7.5.0 the route returned 404 (not_admin → not_found mapping).
    // The new defense-in-depth helper returns 403 no_membership; both
    // are non-enumerating responses.
    const orgId = randomUUID();
    seedAdmin(orgId);
    currentUser = { id: randomUUID() };
    const r = await GET(req(orgId), { params: { orgId } });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('no_membership');
  });

  it('test 4: paginates via cursor', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    seedEvents(orgId, 5);
    currentUser = { id: admin };
    const r1 = await GET(req(orgId, 'limit=2'), { params: { orgId } });
    const body1 = await r1.json();
    expect(body1.events.length).toBe(2);
    expect(body1.nextCursor).toBeTruthy();
    const r2 = await GET(req(orgId, `limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`), { params: { orgId } });
    const body2 = await r2.json();
    expect(body2.events.length).toBe(2);
    expect(body2.events[0].id).not.toBe(body1.events[0].id);
  });

  it('test 5: filter by action', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    seedEvents(orgId, 2);
    stub.tables.get('audit_events')!.push({
      id: 9999, organization_id: orgId, action: 'org.settings.updated',
      actor_user_id: null, subject_type: 'org', subject_id: orgId,
      metadata: {}, occurred_at: '2026-04-15T13:00:00Z', prev_hash: null, this_hash: 'h-x',
    });
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'action=org.settings.updated'), { params: { orgId } });
    const body = await r.json();
    expect(body.events.length).toBe(1);
    expect(body.events[0].action).toBe('org.settings.updated');
  });

  it('test 6: filter by actorId', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    const otherActor = randomUUID();
    stub.seed('audit_events', [
      { id: 1, organization_id: orgId, action: 'a', actor_user_id: admin, subject_type: 'x', subject_id: 'x', metadata: {}, occurred_at: '2026-04-15T12:00:00Z', prev_hash: null, this_hash: 'h1' },
      { id: 2, organization_id: orgId, action: 'a', actor_user_id: otherActor, subject_type: 'x', subject_id: 'x', metadata: {}, occurred_at: '2026-04-15T12:01:00Z', prev_hash: null, this_hash: 'h2' },
    ]);
    currentUser = { id: admin };
    const r = await GET(req(orgId, `actorId=${admin}`), { params: { orgId } });
    const body = await r.json();
    expect(body.events.length).toBe(1);
    expect(body.events[0].actorUserId).toBe(admin);
  });

  it('test 7: filter by since/until — inclusive of since, exclusive of until', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    stub.seed('audit_events', [
      { id: 1, organization_id: orgId, action: 'a', actor_user_id: null, subject_type: 'x', subject_id: 'x', metadata: {}, occurred_at: '2026-04-01T00:00:00Z', prev_hash: null, this_hash: 'h1' },
      { id: 2, organization_id: orgId, action: 'a', actor_user_id: null, subject_type: 'x', subject_id: 'x', metadata: {}, occurred_at: '2026-04-15T12:00:00Z', prev_hash: null, this_hash: 'h2' },
      { id: 3, organization_id: orgId, action: 'a', actor_user_id: null, subject_type: 'x', subject_id: 'x', metadata: {}, occurred_at: '2026-05-01T00:00:00Z', prev_hash: null, this_hash: 'h3' },
    ]);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-04-01T00:00:00Z&until=2026-05-01T00:00:00Z'), { params: { orgId } });
    const body = await r.json();
    expect(body.events.length).toBe(2);  // includes id=1, id=2; excludes id=3
  });

  it('test 7b: malformed since (bad ISO) → 422', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'since=2026-04-01'), { params: { orgId } });
    expect(r.status).toBe(422);
  });

  it('test 8: malformed orgId → 422', async () => {
    currentUser = { id: randomUUID() };
    const r = await GET(req('not-a-uuid'), { params: { orgId: 'not-a-uuid' } });
    expect(r.status).toBe(422);
  });

  it('test 9: limit > 200 clamped (stub honors p_limit)', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    seedEvents(orgId, 250);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'limit=500'), { params: { orgId } });
    const body = await r.json();
    expect(body.events.length).toBeLessThanOrEqual(200);
  });

  it('test 9b: limit = 0 → 422', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'limit=0'), { params: { orgId } });
    expect(r.status).toBe(422);
  });

  it('codex-pr WARNING: limit=25abc → 422 (digits-only)', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'limit=25abc'), { params: { orgId } });
    expect(r.status).toBe(422);
  });

  it('codex-pr CRITICAL: nextCursor round-trips even when stub emits offset notation', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    // Seed events with offset notation in occurred_at — simulates Postgres timestamptz JSON output.
    stub.seed('audit_events', [
      { id: 1, organization_id: orgId, action: 'a', actor_user_id: null, subject_type: 'x', subject_id: 'x', metadata: {}, occurred_at: '2026-04-15T12:00:00+00:00', prev_hash: null, this_hash: 'h1' },
      { id: 2, organization_id: orgId, action: 'a', actor_user_id: null, subject_type: 'x', subject_id: 'x', metadata: {}, occurred_at: '2026-04-15T12:01:00+00:00', prev_hash: null, this_hash: 'h2' },
      { id: 3, organization_id: orgId, action: 'a', actor_user_id: null, subject_type: 'x', subject_id: 'x', metadata: {}, occurred_at: '2026-04-15T12:02:00+00:00', prev_hash: null, this_hash: 'h3' },
    ]);
    currentUser = { id: admin };
    const r1 = await GET(req(orgId, 'limit=2'), { params: { orgId } });
    const body1 = await r1.json();
    expect(body1.nextCursor).toBeTruthy();
    // Send the cursor back; must be accepted (round-trip).
    const r2 = await GET(req(orgId, `limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`), { params: { orgId } });
    expect(r2.status).toBe(200);
  });

  it('test 9c: bad cursor → 422 bad_cursor', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    currentUser = { id: admin };
    const r = await GET(req(orgId, 'cursor=!!!notbase64!!!'), { params: { orgId } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('bad_cursor');
  });

  it('test 10: actor_user_id NULL on event row → email = null but event still listed', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    seedEvents(orgId, 1);  // events have actor_user_id: null
    currentUser = { id: admin };
    const r = await GET(req(orgId), { params: { orgId } });
    const body = await r.json();
    expect(body.events[0].actorUserId).toBeNull();
    expect(body.events[0].actorEmail).toBeNull();
  });

  it('test 11: prev_hash / this_hash passed through unchanged', async () => {
    const orgId = randomUUID();
    const { admin } = seedAdmin(orgId);
    stub.seed('audit_events', [{
      id: 7, organization_id: orgId, action: 'a', actor_user_id: null,
      subject_type: 'x', subject_id: 'x', metadata: {},
      occurred_at: '2026-04-15T12:00:00Z',
      prev_hash: 'PREV-CHAIN',
      this_hash: 'THIS-CHAIN',
    }]);
    currentUser = { id: admin };
    const r = await GET(req(orgId), { params: { orgId } });
    const body = await r.json();
    expect(body.events[0].prevHash).toBe('PREV-CHAIN');
    expect(body.events[0].thisHash).toBe('THIS-CHAIN');
  });
});
