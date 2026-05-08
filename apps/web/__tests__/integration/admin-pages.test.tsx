// Phase 5.1 — admin pages integration tests (Tests 32-35).
//
// Server Components are async. We invoke them directly with Supabase
// boundaries stubbed via vi.mock and assert on rendered output.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import React from 'react';
import { render } from '@testing-library/react';
import { stub } from '../_helpers/supabase-stub';

const notFoundCalls: number[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`__redirect__:${url}`); },
  notFound: () => { notFoundCalls.push(Date.now()); throw new Error('__notFound__'); },
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));

let currentUser: { id: string; email?: string } | null = null;
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));

const MembersPage = (await import('@/app/dashboard/admin/members/page')).default;
const SettingsPage = (await import('@/app/dashboard/admin/settings/page')).default;

beforeEach(() => {
  stub.reset();
  notFoundCalls.length = 0;
  currentUser = null;
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

describe('Phase 5.1 admin pages', () => {
  it('test 32: /dashboard/admin/members renders for admin → shows members table', async () => {
    const orgId = randomUUID();
    const adminUser = randomUUID();
    const peer = randomUUID();
    currentUser = { id: adminUser };
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: adminUser, role: 'admin', status: 'active', joined_at: new Date().toISOString() },
      { id: randomUUID(), organization_id: orgId, user_id: peer, role: 'member', status: 'active', joined_at: new Date().toISOString() },
    ]);
    stub.seed('auth.users', [
      { id: adminUser, email: 'admin@autopilot.dev' },
      { id: peer, email: 'peer@autopilot.dev' },
    ]);
    const { html } = await tryRender(MembersPage({ searchParams: Promise.resolve({ orgId }) }));
    expect(html).toContain('Members');
    expect(html).toContain('admin@autopilot.dev');
    expect(html).toContain('peer@autopilot.dev');
  });

  it('test 33: /dashboard/admin/members for member-role user → notFound', async () => {
    const orgId = randomUUID();
    const me = randomUUID();
    currentUser = { id: me };
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: me, role: 'member', status: 'active', joined_at: new Date().toISOString() },
    ]);
    const { threwNotFound } = await tryRender(MembersPage({ searchParams: Promise.resolve({ orgId }) }));
    expect(threwNotFound).toBe(true);
  });

  it('test 34: /dashboard/admin/settings for non-owner → notFound', async () => {
    const orgId = randomUUID();
    const adminUser = randomUUID();
    currentUser = { id: adminUser };
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: adminUser, role: 'admin', status: 'active', joined_at: new Date().toISOString() },
    ]);
    stub.seed('organizations', [{ id: orgId, name: 'Acme' }]);
    const { threwNotFound } = await tryRender(SettingsPage({ searchParams: Promise.resolve({ orgId }) }));
    expect(threwNotFound).toBe(true);
  });

  it('test 35: /dashboard/admin/settings for owner → editable form', async () => {
    const orgId = randomUUID();
    const ownerUser = randomUUID();
    currentUser = { id: ownerUser };
    stub.seed('memberships', [
      { id: randomUUID(), organization_id: orgId, user_id: ownerUser, role: 'owner', status: 'active', joined_at: new Date().toISOString() },
    ]);
    stub.seed('organizations', [{ id: orgId, name: 'Acme Corp' }]);
    const { html } = await tryRender(SettingsPage({ searchParams: Promise.resolve({ orgId }) }));
    expect(html).toContain('Organization settings');
    expect(html).toContain('Acme Corp');
  });
});
