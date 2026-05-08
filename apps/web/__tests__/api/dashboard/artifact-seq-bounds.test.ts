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

describe('artifact seq bounds', () => {
  it('test 30: seq=999 with only 2 chunks → 422', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    currentUser = { id: userId };
    stub.seed('runs', [{
      id: runId,
      user_id: userId,
      organization_id: null,
      visibility: 'private',
      events_index_path: `user/${userId}/${runId}/events.index.json`,
      state_blob_path: `user/${userId}/${runId}/state.json`,
      source_verified: true,
      upload_session_id: sessionId,
    }]);
    stub.seed('upload_session_chunks', [
      { session_id: sessionId, seq: 0, hash: 'h0', bytes: 10, storage_path: `user/${userId}/${runId}/events/0.ndjson`, status: 'persisted' },
      { session_id: sessionId, seq: 1, hash: 'h1', bytes: 10, storage_path: `user/${userId}/${runId}/events/1.ndjson`, status: 'persisted' },
    ]);
    const r = await GET(
      new Request(`http://x/api/dashboard/runs/${runId}/artifact?kind=chunk&seq=999`),
      { params: { runId } },
    );
    expect(r.status).toBe(422);
    const body = await r.json();
    expect(body.error).toMatch(/out of range/);
  });

  it('seq below 0 → 422', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    currentUser = { id: userId };
    stub.seed('runs', [{
      id: runId,
      user_id: userId,
      organization_id: null,
      visibility: 'private',
      events_index_path: 'p',
      state_blob_path: 'p2',
      source_verified: true,
      upload_session_id: randomUUID(),
    }]);
    const r = await GET(
      new Request(`http://x/api/dashboard/runs/${runId}/artifact?kind=chunk&seq=-1`),
      { params: { runId } },
    );
    expect(r.status).toBe(422);
  });
});
