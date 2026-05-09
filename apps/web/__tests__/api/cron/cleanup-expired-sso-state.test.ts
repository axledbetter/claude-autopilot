import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stub } from '../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));

const { GET } = await import('@/app/api/cron/cleanup-expired-sso-state/route');

beforeEach(() => {
  stub.reset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.CRON_SECRET = 'cron-secret-stub';
});

function req(authHeader?: string): Request {
  return new Request('http://x/api/cron/cleanup-expired-sso-state', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe('GET /api/cron/cleanup-expired-sso-state', () => {
  it('valid CRON_SECRET → 200 with counts; codex PR-pass WARNING #2 — RPC called with exact args', async () => {
    const rpcSpy = vi.spyOn(stub, 'callRpc');
    const r = await GET(req('Bearer cron-secret-stub'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.expiredStatesDeleted).toBe(0);
    expect(body.oldEventsDeleted).toBe(0);
    expect(rpcSpy).toHaveBeenCalledWith('cleanup_expired_sso_states', {
      p_state_age_hours: 24,
      p_event_age_days: 30,
    });
    rpcSpy.mockRestore();
  });

  it('missing Authorization header → 401', async () => {
    const r = await GET(req());
    expect(r.status).toBe(401);
  });

  it('wrong CRON_SECRET → 401', async () => {
    const r = await GET(req('Bearer wrong'));
    expect(r.status).toBe(401);
  });

  it('CRON_SECRET unset → 500 cron_secret_missing', async () => {
    delete process.env.CRON_SECRET;
    const r = await GET(req('Bearer anything'));
    expect(r.status).toBe(500);
    expect((await r.json()).error).toBe('cron_secret_missing');
  });
});
