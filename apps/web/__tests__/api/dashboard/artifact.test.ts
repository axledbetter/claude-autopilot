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

interface Seeded {
  runId: string;
  userId: string;
  sessionId: string;
}

function seedRun(opts: { visibility: 'public' | 'private'; chunks?: number; orgId?: string | null } = { visibility: 'private' }): Seeded {
  const userId = randomUUID();
  const runId = randomUUID();
  const sessionId = randomUUID();
  const orgId = opts.orgId ?? null;
  const root = orgId ? `org/${orgId}` : `user/${userId}`;
  stub.seed('runs', [{
    id: runId,
    user_id: userId,
    organization_id: orgId,
    visibility: opts.visibility,
    events_index_path: `${root}/${runId}/events.index.json`,
    state_blob_path: `${root}/${runId}/state.json`,
    source_verified: true,
    upload_session_id: sessionId,
  }]);
  const chunkCount = opts.chunks ?? 2;
  const chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push({
      session_id: sessionId, seq: i, hash: `h${i}`, bytes: 100,
      storage_path: `${root}/${runId}/events/${i}.ndjson`, status: 'persisted',
    });
  }
  stub.seed('upload_session_chunks', chunks);
  return { runId, userId, sessionId };
}

function req(runId: string, qs: string): Request {
  return new Request(`http://x/api/dashboard/runs/${runId}/artifact?${qs}`);
}

describe('GET /api/dashboard/runs/:runId/artifact', () => {
  it('test 5: owner GET ?kind=manifest → 200 with signedUrl', async () => {
    const s = seedRun({ visibility: 'private' });
    currentUser = { id: s.userId };
    const r = await GET(req(s.runId, 'kind=manifest'), { params: { runId: s.runId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toMatch(/^https:\/\/stub\.example\//);
    expect(body.url).toContain('events.index.json');
  });

  it('test 6: owner GET ?kind=chunk&seq=0 → 200', async () => {
    const s = seedRun({ visibility: 'private', chunks: 2 });
    currentUser = { id: s.userId };
    const r = await GET(req(s.runId, 'kind=chunk&seq=0'), { params: { runId: s.runId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toContain('events%2F0.ndjson');
  });

  it('test 7: owner GET ?kind=state → 200', async () => {
    const s = seedRun({ visibility: 'private' });
    currentUser = { id: s.userId };
    const r = await GET(req(s.runId, 'kind=state'), { params: { runId: s.runId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toContain('state.json');
  });

  it('test 8: anon GET on visibility=public run → 200 (manifest)', async () => {
    const s = seedRun({ visibility: 'public' });
    // currentUser stays null.
    const r = await GET(req(s.runId, 'kind=manifest'), { params: { runId: s.runId } });
    expect(r.status).toBe(200);
  });

  it('test 8b: anon GET on public run → state allowed', async () => {
    const s = seedRun({ visibility: 'public' });
    const r = await GET(req(s.runId, 'kind=state'), { params: { runId: s.runId } });
    expect(r.status).toBe(200);
  });

  it('test 9: anon GET on visibility=private run → 401', async () => {
    const s = seedRun({ visibility: 'private' });
    const r = await GET(req(s.runId, 'kind=manifest'), { params: { runId: s.runId } });
    expect(r.status).toBe(401);
  });

  it('test 9b: non-owner authenticated user on private run → 404', async () => {
    const s = seedRun({ visibility: 'private' });
    currentUser = { id: randomUUID() };
    const r = await GET(req(s.runId, 'kind=manifest'), { params: { runId: s.runId } });
    expect(r.status).toBe(404);
  });

  it('test 10: invalid kind → 422', async () => {
    const s = seedRun({ visibility: 'private' });
    currentUser = { id: s.userId };
    const r = await GET(req(s.runId, 'kind=secrets'), { params: { runId: s.runId } });
    expect(r.status).toBe(422);
  });

  it('returns 404 when run does not exist', async () => {
    const r = await GET(req(randomUUID(), 'kind=manifest'), { params: { runId: randomUUID() } });
    expect(r.status).toBe(404);
  });

  // Codex pass 3 CRITICAL — soft-deleted runs MUST NOT mint signed URLs
  // even if visibility='public'. Service role client bypasses RLS, so the
  // route enforces the deleted_at check.
  it('codex-3: anon GET on soft-deleted public run → 404 (artifact not minted)', async () => {
    const s = seedRun({ visibility: 'public' });
    const row = stub.tables.get('runs')!.find((r) => r.id === s.runId)!;
    row.deleted_at = new Date('2026-05-01').toISOString();
    const r = await GET(req(s.runId, 'kind=manifest'), { params: { runId: s.runId } });
    expect(r.status).toBe(404);
  });

  it('codex-3: owner GET on own soft-deleted run → 404', async () => {
    const s = seedRun({ visibility: 'private' });
    currentUser = { id: s.userId };
    const row = stub.tables.get('runs')!.find((r) => r.id === s.runId)!;
    row.deleted_at = new Date('2026-05-01').toISOString();
    const r = await GET(req(s.runId, 'kind=state'), { params: { runId: s.runId } });
    expect(r.status).toBe(404);
  });
});
