// v7.1.3 — operator deploy-verification endpoint.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stub } from '../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));

const { GET } = await import('@/app/api/health/v7-readiness/route');

const SECRET_64 = 'a'.repeat(64);

const REQUIRED_ENVS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://stub',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  AUTOPILOT_PUBLIC_BASE_URL: 'https://autopilot.dev',
  UPLOAD_SESSION_JWT_SECRET: SECRET_64,
  SSO_STATE_SIGNING_SECRET: SECRET_64,
  MEMBERSHIP_CHECK_COOKIE_SECRET: SECRET_64,
  STRIPE_SECRET_KEY: 'sk_test_xxx',
  STRIPE_WEBHOOK_SECRET: 'whsec_xxx',
  WORKOS_API_KEY: 'sk_test_workos',
  WORKOS_CLIENT_ID: 'client_xxx',
  WORKOS_WEBHOOK_SECRET: 'whsec_workos',
  CRON_SECRET: 'cron-secret-stub',
};

beforeEach(() => {
  stub.reset();
  for (const [k, v] of Object.entries(REQUIRED_ENVS)) process.env[k] = v;
});

function req(authHeader?: string): Request {
  return new Request('http://x/api/health/v7-readiness', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe('GET /api/health/v7-readiness', () => {
  it('all required env vars + RPC available → 200 ok=true', async () => {
    const r = await GET(req('Bearer cron-secret-stub'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.failed).toBe(0);
    expect(body.checks.length).toBeGreaterThanOrEqual(13);
    // Every check is pass.
    expect(body.checks.every((c: { status: string }) => c.status === 'pass')).toBe(true);
    // RPC check is included.
    const rpcCheck = body.checks.find((c: { name: string }) => c.name === 'check_membership_status_rpc');
    expect(rpcCheck).toBeTruthy();
    expect(rpcCheck.status).toBe('pass');
  });

  it('missing required env var → 503 ok=false + names the failing check', async () => {
    delete process.env.WORKOS_API_KEY;
    const r = await GET(req('Bearer cron-secret-stub'));
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.failed).toBeGreaterThanOrEqual(1);
    const failing = body.checks.filter((c: { status: string }) => c.status === 'fail');
    const failingNames = failing.map((c: { name: string }) => c.name);
    expect(failingNames).toContain('WORKOS_API_KEY');
    // Diagnostic message is present (operator must be able to see what to fix).
    const workosCheck = failing.find((c: { name: string }) => c.name === 'WORKOS_API_KEY');
    expect(workosCheck.message).toMatch(/not set/);
  });

  it('secret env var present but too short → 503 with byte-count diagnostic', async () => {
    process.env.MEMBERSHIP_CHECK_COOKIE_SECRET = 'short'; // 5 bytes < 32
    const r = await GET(req('Bearer cron-secret-stub'));
    expect(r.status).toBe(503);
    const body = await r.json();
    const failing = body.checks.find((c: { name: string }) => c.name === 'MEMBERSHIP_CHECK_COOKIE_SECRET');
    expect(failing.status).toBe('fail');
    expect(failing.message).toMatch(/too short/);
    expect(failing.message).toMatch(/got 5 bytes/);
  });

  it('check_membership_status RPC missing → 503', async () => {
    // Force the stub callRpc to throw for this RPC name only.
    const original = stub.callRpc.bind(stub);
    const spy = vi.spyOn(stub, 'callRpc').mockImplementation(async (fn, args) => {
      if (fn === 'check_membership_status') {
        return { data: null, error: { message: 'function check_membership_status does not exist' } };
      }
      return original(fn, args);
    });
    const r = await GET(req('Bearer cron-secret-stub'));
    expect(r.status).toBe(503);
    const body = await r.json();
    const rpcCheck = body.checks.find((c: { name: string }) => c.name === 'check_membership_status_rpc');
    expect(rpcCheck.status).toBe('fail');
    expect(rpcCheck.message).toMatch(/RPC error/);
    spy.mockRestore();
  });

  it('missing Authorization header → 401', async () => {
    const r = await GET(req());
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error).toBe('unauthorized');
  });

  it('wrong CRON_SECRET → 401 (constant-time compare)', async () => {
    const r = await GET(req('Bearer wrong-value'));
    expect(r.status).toBe(401);
  });

  it('CRON_SECRET unset → 500 cron_secret_missing', async () => {
    delete process.env.CRON_SECRET;
    const r = await GET(req('Bearer anything'));
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toBe('cron_secret_missing');
  });

  it('Bearer header malformed (no Bearer prefix) → 401', async () => {
    const r = await GET(req('cron-secret-stub'));
    expect(r.status).toBe(401);
  });
});
