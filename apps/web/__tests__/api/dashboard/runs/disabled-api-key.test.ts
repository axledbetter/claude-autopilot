// Phase 5.8 — disabled API-key holder regression.
//
// Closes the Phase 5.7 known gap: a member who got disabled AFTER
// creating an org-scoped run could still upload via their API key
// because the route's authorization was `user_id === auth.userId`
// without re-checking membership status. Phase 5.8 fixed both
// upload-session and artifact routes to ALWAYS require active
// membership when the run is org-scoped, regardless of ownership.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID, createHash } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));

const { GET: uploadSession } = await import('@/app/api/dashboard/runs/[runId]/upload-session/route');
const { GET: artifact } = await import('@/app/api/dashboard/runs/[runId]/artifact/route');

beforeEach(() => {
  stub.reset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.UPLOAD_SESSION_JWT_SECRET = '0'.repeat(64);
});

interface SeedResult { runId: string; userId: string; orgId: string; rawApiKey: string }

function seedDisabledMemberWithApiKey(): SeedResult {
  const userId = randomUUID();
  const orgId = randomUUID();
  const runId = randomUUID();
  const rawApiKey = `clp_${'a'.repeat(64)}`;
  const keyHash = createHash('sha256').update(rawApiKey).digest('hex');
  stub.seed('organizations', [{ id: orgId, name: 'Acme' }]);
  stub.seed('memberships', [{
    id: randomUUID(),
    organization_id: orgId,
    user_id: userId,
    role: 'member',
    status: 'disabled',  // KEY: status is disabled
    joined_at: new Date().toISOString(),
  }]);
  stub.seed('api_keys', [{
    id: randomUUID(),
    user_id: userId,
    key_hash: keyHash,
    revoked_at: null,
    created_at: new Date().toISOString(),
  }]);
  stub.seed('runs', [{
    id: runId,
    user_id: userId,
    organization_id: orgId,
    visibility: 'private',
    deleted_at: null,
  }]);
  return { runId, userId, orgId, rawApiKey };
}

describe('Phase 5.8 — disabled API-key holder cannot access org-scoped runs they created', () => {
  it('upload-session GET: disabled member with API key for own run → 404 not_found', async () => {
    const { runId, rawApiKey } = seedDisabledMemberWithApiKey();
    const r = await uploadSession(
      new Request(`http://x/api/dashboard/runs/${runId}/upload-session`, {
        method: 'GET',
        headers: { authorization: `Bearer ${rawApiKey}` },
      }),
      { params: { runId } },
    );
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('not found');
  });

  it('artifact GET: disabled member with API key for own run → 404 not_found', async () => {
    const { runId, rawApiKey } = seedDisabledMemberWithApiKey();
    const r = await artifact(
      new Request(`http://x/api/dashboard/runs/${runId}/artifact?kind=manifest`, {
        method: 'GET',
        headers: { authorization: `Bearer ${rawApiKey}` },
      }),
      { params: { runId } },
    );
    expect(r.status).toBe(404);
  });

  it('regression: ACTIVE member with API key for own org-scoped run → 200 (session found)', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    const runId = randomUUID();
    const rawApiKey = `clp_${'b'.repeat(64)}`;
    const keyHash = createHash('sha256').update(rawApiKey).digest('hex');
    stub.seed('organizations', [{ id: orgId, name: 'Acme' }]);
    stub.seed('memberships', [{
      id: randomUUID(), organization_id: orgId, user_id: userId,
      role: 'member', status: 'active', joined_at: new Date().toISOString(),
    }]);
    stub.seed('api_keys', [{
      id: randomUUID(), user_id: userId, key_hash: keyHash,
      revoked_at: null, created_at: new Date().toISOString(),
    }]);
    stub.seed('runs', [{
      id: runId, user_id: userId, organization_id: orgId,
      visibility: 'private', deleted_at: null,
    }]);
    // Seed an in-flight upload_sessions row so the route hits the
    // happy path (re-mint JWT) instead of "no session" 404.
    stub.seed('upload_sessions', [{
      id: randomUUID(),
      run_id: runId,
      user_id: userId,
      organization_id: orgId,
      jti: randomUUID(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      consumed_at: null,
      next_expected_seq: 1,
      token_hash: 'x'.repeat(64),
      created_at: new Date().toISOString(),
    }]);
    const r = await uploadSession(
      new Request(`http://x/api/dashboard/runs/${runId}/upload-session`, {
        method: 'GET',
        headers: { authorization: `Bearer ${rawApiKey}` },
      }),
      { params: { runId } },
    );
    expect(r.status).toBe(200);
  });

  it('personal (non-org) run owned by user → membership check skipped, ownership check passes', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    const rawApiKey = `clp_${'c'.repeat(64)}`;
    const keyHash = createHash('sha256').update(rawApiKey).digest('hex');
    stub.seed('api_keys', [{
      id: randomUUID(), user_id: userId, key_hash: keyHash,
      revoked_at: null, created_at: new Date().toISOString(),
    }]);
    stub.seed('runs', [{
      id: runId, user_id: userId, organization_id: null,
      visibility: 'private', deleted_at: null,
    }]);
    stub.seed('upload_sessions', [{
      id: randomUUID(),
      run_id: runId,
      user_id: userId,
      organization_id: null,
      jti: randomUUID(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      consumed_at: null,
      next_expected_seq: 1,
      token_hash: 'x'.repeat(64),
      created_at: new Date().toISOString(),
    }]);
    const r = await uploadSession(
      new Request(`http://x/api/dashboard/runs/${runId}/upload-session`, {
        method: 'GET',
        headers: { authorization: `Bearer ${rawApiKey}` },
      }),
      { params: { runId } },
    );
    expect(r.status).toBe(200);
  });
});
