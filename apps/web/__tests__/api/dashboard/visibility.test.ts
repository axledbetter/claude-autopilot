import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));

const { PATCH } = await import('@/app/api/dashboard/runs/[runId]/visibility/route');
const { _resetBillingConfigForTests } = await import('@/lib/billing/plan-map');

beforeEach(() => {
  stub.reset();
  _resetBillingConfigForTests();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function req(runId: string, body: object, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/api/dashboard/runs/${runId}/visibility`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev', ...headers },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/dashboard/runs/:runId/visibility', () => {
  it('test 1: owner toggles to public → 200 + visibility persisted', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    currentUser = { id: userId };
    stub.seed('runs', [{ id: runId, user_id: userId, visibility: 'private' }]);
    const r = await PATCH(req(runId, { visibility: 'public' }), { params: { runId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.visibility).toBe('public');
    const updated = stub.tables.get('runs')!.find((row) => row.id === runId);
    expect(updated?.visibility).toBe('public');
  });

  it('test 2: owner toggles to private → 200', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    currentUser = { id: userId };
    stub.seed('runs', [{ id: runId, user_id: userId, visibility: 'public' }]);
    const r = await PATCH(req(runId, { visibility: 'private' }), { params: { runId } });
    expect(r.status).toBe(200);
    const updated = stub.tables.get('runs')!.find((row) => row.id === runId);
    expect(updated?.visibility).toBe('private');
  });

  it('test 3: non-owner → 404 (not 403, to avoid enumeration)', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const runId = randomUUID();
    currentUser = { id: other };
    stub.seed('runs', [{ id: runId, user_id: owner, visibility: 'private' }]);
    const r = await PATCH(req(runId, { visibility: 'public' }), { params: { runId } });
    expect(r.status).toBe(404);
    // Visibility unchanged.
    const row = stub.tables.get('runs')!.find((x) => x.id === runId);
    expect(row?.visibility).toBe('private');
  });

  it('test 4: anon → 401', async () => {
    const runId = randomUUID();
    stub.seed('runs', [{ id: runId, user_id: randomUUID(), visibility: 'private' }]);
    const r = await PATCH(req(runId, { visibility: 'public' }), { params: { runId } });
    expect(r.status).toBe(401);
  });

  it('rejects invalid visibility value → 422', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    currentUser = { id: userId };
    stub.seed('runs', [{ id: runId, user_id: userId, visibility: 'private' }]);
    const r = await PATCH(req(runId, { visibility: 'world-readable' }), { params: { runId } });
    expect(r.status).toBe(422);
  });

  // Spec test 28 — Origin guard fires before any auth/lookup.
  it('test 28: mismatched Origin → 403 even with valid cookie session', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    currentUser = { id: userId };
    stub.seed('runs', [{ id: runId, user_id: userId, visibility: 'private' }]);
    const r = await PATCH(
      req(runId, { visibility: 'public' }, { origin: 'https://attacker.example' }),
      { params: { runId } },
    );
    expect(r.status).toBe(403);
    // Visibility unchanged.
    const row = stub.tables.get('runs')!.find((x) => x.id === runId);
    expect(row?.visibility).toBe('private');
  });
});
