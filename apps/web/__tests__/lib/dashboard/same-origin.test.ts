import { describe, it, expect, beforeEach } from 'vitest';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { _resetBillingConfigForTests } from '@/lib/billing/plan-map';

beforeEach(() => {
  _resetBillingConfigForTests();
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

describe('assertSameOrigin', () => {
  it('returns ok when origin matches AUTOPILOT_PUBLIC_BASE_URL', () => {
    const req = new Request('http://internal/api/foo', {
      method: 'POST',
      headers: { origin: 'https://autopilot.dev' },
    });
    expect(assertSameOrigin(req)).toEqual({ ok: true });
  });

  it('returns failure when origin header is missing', () => {
    const req = new Request('http://internal/api/foo', { method: 'POST' });
    const result = assertSameOrigin(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing origin/);
  });

  it('returns failure when origin does not match expected', () => {
    const req = new Request('http://internal/api/foo', {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });
    const result = assertSameOrigin(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/origin mismatch/);
  });
});
