import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../_helpers/supabase-stub';

let cookieValue: string | null = null;
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => name === 'cao_active_org' && cookieValue ? { value: cookieValue } : undefined,
    getAll: () => [],
    set: () => {},
  }),
}));

const { resolveActiveOrg } = await import('@/lib/dashboard/active-org');

beforeEach(() => {
  stub.reset();
  cookieValue = null;
});

function asClient(): never { return stub.asClient() as never; }

describe('resolveActiveOrg', () => {
  it('test 7: returns cookie value when caller has active membership for it', async () => {
    const me = randomUUID();
    const orgA = randomUUID();
    const orgB = randomUUID();
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgA, user_id: me, role: 'member', status: 'active', joined_at: '2026-01-01' },
      { id: randomUUID(), organization_id: orgB, user_id: me, role: 'admin', status: 'active', joined_at: '2026-02-01' },
    ]);
    cookieValue = orgB;
    const ctx = await resolveActiveOrg(asClient(), me);
    expect(ctx).toEqual({ orgId: orgB, fromCookie: true });
  });

  it('test 8: falls back to first membership when cookie missing', async () => {
    const me = randomUUID();
    const orgA = randomUUID();
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgA, user_id: me, role: 'member', status: 'active', joined_at: '2026-01-01' },
    ]);
    cookieValue = null;
    const ctx = await resolveActiveOrg(asClient(), me);
    expect(ctx).toEqual({ orgId: orgA, fromCookie: false });
  });

  it('test 9: falls back when cookie value is no longer an active membership (stale)', async () => {
    const me = randomUUID();
    const orgA = randomUUID();
    const staleOrg = randomUUID();
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgA, user_id: me, role: 'member', status: 'active', joined_at: '2026-01-01' },
    ]);
    cookieValue = staleOrg;
    const ctx = await resolveActiveOrg(asClient(), me);
    expect(ctx).toEqual({ orgId: orgA, fromCookie: false });
  });

  it('test 10: returns null when caller has no active memberships', async () => {
    const me = randomUUID();
    const ctx = await resolveActiveOrg(asClient(), me);
    expect(ctx).toBeNull();
  });

  it('codex-pass: stale cookie pointing at removed org does not bypass membership check', async () => {
    const me = randomUUID();
    const orgA = randomUUID();
    const removedOrg = randomUUID();
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgA, user_id: me, role: 'member', status: 'active', joined_at: '2026-01-01' },
      { id: randomUUID(), organization_id: removedOrg, user_id: me, role: 'admin', status: 'removed', joined_at: '2026-01-01' },
    ]);
    cookieValue = removedOrg;
    const ctx = await resolveActiveOrg(asClient(), me);
    // Cookie points at an org caller is no longer in → fallback to active orgA.
    expect(ctx).toEqual({ orgId: orgA, fromCookie: false });
  });
});
