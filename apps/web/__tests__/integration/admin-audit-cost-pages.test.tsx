// Phase 5.2 — admin audit + cost page integration tests (Tests 23-26).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import React from 'react';
import { render } from '@testing-library/react';
import { stub } from '../_helpers/supabase-stub';

const notFoundCalls: number[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`__redirect__:${url}`); },
  notFound: () => { notFoundCalls.push(Date.now()); throw new Error('__notFound__'); },
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));

let currentUser: { id: string } | null = null;
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));

const AuditPage = (await import('@/app/dashboard/admin/audit/page')).default;
const CostPage = (await import('@/app/dashboard/admin/cost/page')).default;

beforeEach(() => {
  stub.reset();
  notFoundCalls.length = 0;
  currentUser = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));
});

async function tryRender(node: Promise<React.ReactElement>): Promise<{ html: string | null; threwNotFound: boolean }> {
  try {
    const el = await node;
    const r = render(el);
    return { html: r.container.innerHTML, threwNotFound: false };
  } catch (err) {
    if ((err as Error).message === '__notFound__') return { html: null, threwNotFound: true };
    throw err;
  }
}

describe('Phase 5.2 admin audit + cost pages', () => {
  it('test 23: /dashboard/admin/audit renders for admin → shows event row', async () => {
    const orgId = randomUUID();
    const adminUser = randomUUID();
    currentUser = { id: adminUser };
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: adminUser, role: 'admin', status: 'active', joined_at: new Date().toISOString() },
    ]);
    stub.seed('audit_events', [
      { id: 1, organization_id: orgId, action: 'org.member.invited', actor_user_id: adminUser, subject_type: 'membership', subject_id: 'sub-1', metadata: {}, occurred_at: '2026-04-15T12:00:00Z', prev_hash: null, this_hash: 'h1' },
    ]);
    stub.seed('auth.users', [{ id: adminUser, email: 'admin@autopilot.dev' }]);
    const { html } = await tryRender(AuditPage({ searchParams: Promise.resolve({ orgId }) }));
    expect(html).toContain('Audit log');
    expect(html).toContain('org.member.invited');
    expect(html).toContain('admin@autopilot.dev');
  });

  it('test 24: /dashboard/admin/audit for member → notFound', async () => {
    const orgId = randomUUID();
    const me = randomUUID();
    currentUser = { id: me };
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: me, role: 'member', status: 'active', joined_at: new Date().toISOString() },
    ]);
    const { threwNotFound } = await tryRender(AuditPage({ searchParams: Promise.resolve({ orgId }) }));
    expect(threwNotFound).toBe(true);
  });

  it('test 25: /dashboard/admin/cost for owner → cost table + CSV link', async () => {
    const orgId = randomUUID();
    const ownerUser = randomUUID();
    currentUser = { id: ownerUser };
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: ownerUser, role: 'owner', status: 'active', joined_at: new Date().toISOString() },
    ]);
    stub.seed('auth.users', [{ id: ownerUser, email: 'owner@autopilot.dev' }]);
    stub.seed('runs', [
      { id: randomUUID(), organization_id: orgId, user_id: ownerUser, cost_usd: 2.5, duration_ms: 100, total_bytes: 1000, deleted_at: null, created_at: '2026-04-15T12:00:00Z' },
    ]);
    const { html } = await tryRender(CostPage({ searchParams: Promise.resolve({ orgId }) }));
    expect(html).toContain('Cost report');
    expect(html).toContain('Download CSV');
    expect(html).toContain('owner@autopilot.dev');
    expect(html).toContain('2.50');
  });

  it('test 26: /dashboard/admin/cost?since=2026-04&until=2026-04 uses requested period', async () => {
    const orgId = randomUUID();
    const ownerUser = randomUUID();
    currentUser = { id: ownerUser };
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: ownerUser, role: 'owner', status: 'active', joined_at: new Date().toISOString() },
    ]);
    const { html } = await tryRender(CostPage({ searchParams: Promise.resolve({ orgId, since: '2026-04', until: '2026-04' }) }));
    expect(html).toContain('cost.csv?since=2026-04&amp;until=2026-04');
  });
});
