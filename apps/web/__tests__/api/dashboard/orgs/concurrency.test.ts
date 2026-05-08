import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));
vi.mock('@/lib/billing/plan-map', () => ({
  loadPublicBillingConfig: () => ({ AUTOPILOT_PUBLIC_BASE_URL: 'https://autopilot.dev' }),
}));

const { PATCH } = await import('@/app/api/dashboard/orgs/[orgId]/members/[userId]/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function patchReq(orgId: string, userId: string, body: object): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/members/${userId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev' },
    body: JSON.stringify(body),
  });
}

describe('Phase 5.1 last-owner concurrency proof (codex spec CRITICAL #1)', () => {
  it('test 31: concurrent demotion of two owners — exactly one fails last_owner', async () => {
    const orgId = randomUUID();
    const a = randomUUID(); const b = randomUUID();
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: a, role: 'owner', status: 'active', joined_at: '2026-01-01' },
      { id: randomUUID(), organization_id: orgId, user_id: b, role: 'owner', status: 'active', joined_at: '2026-01-01' },
    ]);
    // Caller A demotes B AND demotes themselves concurrently. After the
    // first demote, only one owner remains; the second hits last_owner.
    currentUser = { id: a };
    const [r1, r2] = await Promise.all([
      PATCH(patchReq(orgId, b, { role: 'admin' }), { params: { orgId, userId: b } }),
      PATCH(patchReq(orgId, a, { role: 'admin' }), { params: { orgId, userId: a } }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 422]);
    // Exactly one owner remains active.
    const owners = stub.tables.get('memberships')!.filter(
      (m) => m.organization_id === orgId && m.role === 'owner' && m.status === 'active',
    );
    expect(owners.length).toBe(1);
  });
});
