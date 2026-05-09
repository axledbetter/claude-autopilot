import { describe, it, expect, beforeEach, vi } from 'vitest';

const constructEventMock = vi.fn();
class FakeWorkOS {
  webhooks = { constructEvent: constructEventMock };
  organizations = {};
  portal = {};
  connections = {};
}
vi.mock('@workos-inc/node', () => ({ WorkOS: FakeWorkOS }));

beforeEach(() => {
  constructEventMock.mockReset();
  vi.resetModules();
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_WEBHOOK_SECRET;
});

describe('lib/workos/client', () => {
  it('test 23a: getWorkOS throws when WORKOS_API_KEY is missing', async () => {
    const mod = await import('@/lib/workos/client');
    expect(() => mod.getWorkOS()).toThrow('WORKOS_API_KEY');
  });

  it('test 23b: getWorkOS returns a singleton', async () => {
    process.env.WORKOS_API_KEY = 'sk_test_xxx';
    const mod = await import('@/lib/workos/client');
    const a = mod.getWorkOS();
    const b = mod.getWorkOS();
    expect(a).toBe(b);
  });

  it('test 23c: verifyWorkOSSignature returns missing_signature with no header', async () => {
    process.env.WORKOS_API_KEY = 'sk_test_xxx';
    process.env.WORKOS_WEBHOOK_SECRET = 'whsec_xxx';
    const mod = await import('@/lib/workos/client');
    const r = await mod.verifyWorkOSSignature('{"a":1}', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_signature');
  });

  it('test 23d: verifyWorkOSSignature returns webhook_secret_not_configured if env missing', async () => {
    process.env.WORKOS_API_KEY = 'sk_test_xxx';
    const mod = await import('@/lib/workos/client');
    const r = await mod.verifyWorkOSSignature('{}', 't=1,v1=x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('webhook_secret_not_configured');
  });

  it('test 23e: verifyWorkOSSignature returns ok with verified event when SDK accepts', async () => {
    process.env.WORKOS_API_KEY = 'sk_test_xxx';
    process.env.WORKOS_WEBHOOK_SECRET = 'whsec_xxx';
    constructEventMock.mockResolvedValue({
      id: 'evt_1', event: 'connection.activated',
      data: { organization_id: 'org_x' }, createdAt: '2026-05-08T00:00:00Z',
    });
    const mod = await import('@/lib/workos/client');
    const r = await mod.verifyWorkOSSignature('{"a":1}', 't=1,v1=stub');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.id).toBe('evt_1');
  });

  it('test 23f: verifyWorkOSSignature catches SDK throw and returns reason', async () => {
    process.env.WORKOS_API_KEY = 'sk_test_xxx';
    process.env.WORKOS_WEBHOOK_SECRET = 'whsec_xxx';
    constructEventMock.mockRejectedValue(new Error('signature mismatch'));
    const mod = await import('@/lib/workos/client');
    const r = await mod.verifyWorkOSSignature('{"a":1}', 't=1,v1=bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('signature mismatch');
  });
});
