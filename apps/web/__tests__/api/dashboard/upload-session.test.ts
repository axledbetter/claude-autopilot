import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stub } from '../../_helpers/supabase-stub';
import { createHash } from 'crypto';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));

const { GET } = await import('@/app/api/dashboard/runs/[runId]/upload-session/route');

beforeEach(() => {
  stub.reset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.UPLOAD_SESSION_JWT_SECRET = 'a'.repeat(48);
});

const KEY_A = `clp_${'a'.repeat(64)}`;

function seedKey(userId: string, raw: string): void {
  const keyHash = createHash('sha256').update(raw).digest('hex');
  stub.seed('api_keys', [{
    id: 'key1', user_id: userId, key_hash: keyHash,
    prefix_display: `clp_${raw.slice(4, 16)}`,
    label: null, created_at: new Date().toISOString(),
    last_used_at: null, revoked_at: null,
  }]);
}

describe('GET /api/dashboard/runs/:runId/upload-session', () => {
  it('returns existing in-flight session JWT for owner', async () => {
    seedKey('user1', KEY_A);
    stub.seed('runs', [{ id: 'run1', user_id: 'user1', organization_id: null }]);
    stub.seed('upload_sessions', [{
      id: 'sess1',
      run_id: 'run1',
      user_id: 'user1',
      organization_id: null,
      jti: 'jti-1',
      token_hash: 'old-hash',
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      consumed_at: null,
      next_expected_seq: 2,
      chain_tip_hash: 'a'.repeat(64),
    }]);

    const r = await GET(
      new Request('http://x', { headers: { authorization: `Bearer ${KEY_A}` } }),
      { params: { runId: 'run1' } },
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.uploadToken).toBeTruthy();
    expect(body.session.id).toBe('sess1');
    expect(body.session.jti).toBe('jti-1');
    expect(body.session.nextExpectedSeq).toBe(2);
  });

  it('returns 404 when no in-flight session exists', async () => {
    seedKey('user1', KEY_A);
    stub.seed('runs', [{ id: 'run1', user_id: 'user1', organization_id: null }]);

    const r = await GET(
      new Request('http://x', { headers: { authorization: `Bearer ${KEY_A}` } }),
      { params: { runId: 'run1' } },
    );
    expect(r.status).toBe(404);
  });

  it('returns 404 (not 403) for run owned by another user', async () => {
    seedKey('user1', KEY_A);
    stub.seed('runs', [{ id: 'run1', user_id: 'other-user', organization_id: null }]);
    stub.seed('upload_sessions', [{
      id: 'sess1',
      run_id: 'run1',
      user_id: 'other-user',
      organization_id: null,
      jti: 'jti-1',
      token_hash: 'h',
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      consumed_at: null,
      next_expected_seq: 0,
      chain_tip_hash: '0'.repeat(64),
    }]);

    const r = await GET(
      new Request('http://x', { headers: { authorization: `Bearer ${KEY_A}` } }),
      { params: { runId: 'run1' } },
    );
    expect(r.status).toBe(404);
  });

  it('returns 401 without API key', async () => {
    stub.seed('runs', [{ id: 'run1', user_id: 'user1', organization_id: null }]);
    const r = await GET(
      new Request('http://x'),
      { params: { runId: 'run1' } },
    );
    expect(r.status).toBe(401);
  });
});
