import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));

let nextVerifyResult: { ok: true; event: { id: string; event: string; data: Record<string, unknown>; createdAt: string } } | { ok: false; reason: string } = { ok: false, reason: 'init' };
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({}),
  verifyWorkOSSignature: async () => nextVerifyResult,
}));

const { POST } = await import('@/app/api/workos/webhook/route');

beforeEach(() => {
  stub.reset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.WORKOS_API_KEY = 'sk_test_stub';
  process.env.WORKOS_WEBHOOK_SECRET = 'whsec_stub';
});

function req(body: object, headers: Record<string, string> = { 'workos-signature': 't=1,v1=stub' }): Request {
  return new Request('http://x/api/workos/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function seedSettings(orgId: string, workosOrgId: string, status: string = 'pending', extra: Record<string, unknown> = {}): void {
  stub.seed('organizations', [{ id: orgId, name: 'O' }]);
  stub.seed('organization_settings', [{
    organization_id: orgId,
    workos_organization_id: workosOrgId,
    sso_connection_status: status,
    workos_connection_id: null,
    sso_last_workos_event_at: null,
    ...extra,
  }]);
}

describe('POST /api/workos/webhook', () => {
  it('test 17: invalid signature → 401 webhook_signature_invalid', async () => {
    nextVerifyResult = { ok: false, reason: 'bad_sig' };
    const r = await POST(req({ event: 'connection.activated', id: 'evt_1', data: {}, createdAt: new Date().toISOString() }));
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('webhook_signature_invalid');
  });

  it('test 18: connection.activated → status active, connection_id set, audit appended', async () => {
    const orgId = randomUUID();
    seedSettings(orgId, 'org_workos_111', 'pending');
    const occurredAt = new Date().toISOString();
    nextVerifyResult = {
      ok: true,
      event: {
        id: 'evt_act_1', event: 'connection.activated',
        data: { organization_id: 'org_workos_111', id: 'conn_xyz' },
        createdAt: occurredAt,
      },
    };
    const r = await POST(req({}));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.result).toBe('applied');
    expect(body.newStatus).toBe('active');
    const settings = stub.tables.get('organization_settings')!.find((s) => s.organization_id === orgId);
    expect(settings?.sso_connection_status).toBe('active');
    expect(settings?.workos_connection_id).toBe('conn_xyz');
    const audits = stub.tables.get('audit_events')!;
    expect(audits.find((a) => a.action === 'org.sso.lifecycle')).toBeTruthy();
  });

  it('test 19: duplicate event → result=duplicate, no second apply', async () => {
    const orgId = randomUUID();
    seedSettings(orgId, 'org_workos_222', 'pending');
    const occurredAt = new Date().toISOString();
    const event = {
      id: 'evt_dup', event: 'connection.activated',
      data: { organization_id: 'org_workos_222', id: 'conn_a' },
      createdAt: occurredAt,
    };
    nextVerifyResult = { ok: true, event };
    await POST(req({}));
    nextVerifyResult = { ok: true, event };
    const r2 = await POST(req({}));
    expect(r2.status).toBe(200);
    expect((await r2.json()).result).toBe('duplicate');
  });

  it('test 20: stale event (older than last_workos_event_at) → no-op stale_event', async () => {
    const orgId = randomUUID();
    const lastAt = new Date('2026-05-01T12:00:00Z').toISOString();
    seedSettings(orgId, 'org_workos_333', 'active', {
      sso_last_workos_event_at: lastAt,
      workos_connection_id: 'conn_old',
    });
    nextVerifyResult = {
      ok: true,
      event: {
        id: 'evt_stale', event: 'connection.deactivated',
        data: { organization_id: 'org_workos_333', id: 'conn_old' },
        createdAt: '2026-04-01T00:00:00Z', // before lastAt
      },
    };
    const r = await POST(req({}));
    expect(r.status).toBe(200);
    expect((await r.json()).result).toBe('stale_event');
    const settings = stub.tables.get('organization_settings')!.find((s) => s.organization_id === orgId);
    expect(settings?.sso_connection_status).toBe('active');
  });

  it('test 21: connection.deleted always wins, even if older', async () => {
    const orgId = randomUUID();
    const lastAt = new Date('2026-05-01T12:00:00Z').toISOString();
    seedSettings(orgId, 'org_workos_444', 'active', {
      sso_last_workos_event_at: lastAt,
      workos_connection_id: 'conn_keep',
    });
    nextVerifyResult = {
      ok: true,
      event: {
        id: 'evt_del', event: 'connection.deleted',
        data: { organization_id: 'org_workos_444', id: 'conn_keep' },
        createdAt: '2026-04-01T00:00:00Z',
      },
    };
    const r = await POST(req({}));
    expect(r.status).toBe(200);
    expect((await r.json()).result).toBe('applied');
    const settings = stub.tables.get('organization_settings')!.find((s) => s.organization_id === orgId);
    expect(settings?.sso_connection_status).toBe('disabled');
    expect(settings?.workos_connection_id).toBe(null);
  });

  it('test 22: unknown WorkOS org → result=unknown_org, no settings change', async () => {
    nextVerifyResult = {
      ok: true,
      event: {
        id: 'evt_unk', event: 'connection.activated',
        data: { organization_id: 'org_workos_does_not_exist', id: 'conn_x' },
        createdAt: new Date().toISOString(),
      },
    };
    const r = await POST(req({}));
    expect(r.status).toBe(200);
    expect((await r.json()).result).toBe('unknown_org');
  });

  it('codex-pr WARNING: unknown_org leaves event row in failed (not processed) for later reconciliation', async () => {
    nextVerifyResult = {
      ok: true,
      event: {
        id: 'evt_unk_recon', event: 'connection.activated',
        data: { organization_id: 'org_workos_no_match', id: 'conn_y' },
        createdAt: new Date().toISOString(),
      },
    };
    await POST(req({}));
    const row = stub.tables.get('processed_workos_events')!.find((e) => e.event_id === 'evt_unk_recon');
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('unknown_workos_organization');
    // processed_at stays null so a reconciliation job can re-process.
    expect(row?.processed_at ?? null).toBe(null);
  });
});
