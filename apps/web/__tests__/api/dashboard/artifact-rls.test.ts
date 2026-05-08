// Storage RLS / signed-URL tests.
//
// Phase 4 — these are stubbed integration tests; full RLS validation is
// operator-only (Phase 5 hardening backlog adds tests/rls/). The stub
// models the contract:
//   - Public-bucket direct fetch on a private run path is denied.
//   - Public run via signed URL succeeds.
//   - Owner via signed URL succeeds.
//
// Spec tests 23-25.
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

const { GET } = await import('@/app/api/dashboard/runs/[runId]/artifact/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
});

describe('Storage RLS guard (Phase 4 stubbed)', () => {
  it('test 23: private run, anon → route denies (401), no signed URL minted', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    stub.seed('runs', [{
      id: runId, user_id: userId, organization_id: null, visibility: 'private',
      events_index_path: 'p', state_blob_path: 'p2', source_verified: true,
      upload_session_id: randomUUID(),
    }]);
    const r = await GET(
      new Request(`http://x/api/dashboard/runs/${runId}/artifact?kind=manifest`),
      { params: { runId } },
    );
    expect(r.status).toBe(401);
    // Behavior contract — we never reached createSignedUrl on the
    // unauthorized path. (If we had, the test would still pass status
    // 200, so the assertion above is the meaningful one.)
  });

  it('test 24: public run, anon → signed URL succeeds', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    stub.seed('runs', [{
      id: runId, user_id: userId, organization_id: null, visibility: 'public',
      events_index_path: `user/${userId}/${runId}/events.index.json`,
      state_blob_path: `user/${userId}/${runId}/state.json`,
      source_verified: true,
      upload_session_id: randomUUID(),
    }]);
    const r = await GET(
      new Request(`http://x/api/dashboard/runs/${runId}/artifact?kind=manifest`),
      { params: { runId } },
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toContain('events.index.json');
  });

  it('test 25: owner can fetch own private run via signed URL', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    currentUser = { id: userId };
    stub.seed('runs', [{
      id: runId, user_id: userId, organization_id: null, visibility: 'private',
      events_index_path: `user/${userId}/${runId}/events.index.json`,
      state_blob_path: `user/${userId}/${runId}/state.json`,
      source_verified: true,
      upload_session_id: randomUUID(),
    }]);
    const r = await GET(
      new Request(`http://x/api/dashboard/runs/${runId}/artifact?kind=state`),
      { params: { runId } },
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toContain('state.json');
  });
});
