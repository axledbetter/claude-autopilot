// Phase 4 — Spec tests 15-19: dashboard page integration tests.
//
// Server Components in Next 16 are async functions. We invoke them
// directly here (jsdom + @testing-library/react), with the Supabase
// boundaries stubbed via vi.mock. This validates render shape + key
// data-flow paths without standing up a real Next dev server.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import React from 'react';
import { render } from '@testing-library/react';
import { stub } from '../_helpers/supabase-stub';

// Capture redirect calls from next/navigation so we can assert on them.
const redirectCalls: string[] = [];
const notFoundCalls: number[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirectCalls.push(url);
    throw new Error(`__redirect__:${url}`);
  },
  notFound: () => {
    notFoundCalls.push(Date.now());
    throw new Error('__notFound__');
  },
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

// For the public route — anon supabase client built with createClient.
let publicRunRow: Record<string, unknown> | null = null;
vi.mock('@supabase/supabase-js', async (orig) => {
  const actual = await orig() as object;
  return {
    ...actual,
    createClient: () => ({
      from: (_t: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: publicRunRow, error: null }),
            }),
          }),
        }),
      }),
    }),
  };
});

beforeEach(() => {
  stub.reset();
  redirectCalls.length = 0;
  notFoundCalls.length = 0;
  currentUser = null;
  publicRunRow = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
});

describe('Dashboard pages (integration)', () => {
  it('test 15: /dashboard layout redirects unauth → /', async () => {
    const { default: DashboardLayout } = await import('@/app/dashboard/layout');
    let threw: Error | null = null;
    try {
      // Server component returns a Promise — await to trigger redirect.
      await DashboardLayout({ children: <div>x</div> });
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).not.toBeNull();
    expect(redirectCalls.length).toBe(1);
    expect(redirectCalls[0]).toMatch(/^\/\?next=/);
  });

  it('test 16: /dashboard/runs renders a list (mocked supabase fetch)', async () => {
    const userId = randomUUID();
    currentUser = { id: userId, email: 'a@b.com' };
    stub.seed('runs', [
      {
        id: randomUUID(), user_id: userId, organization_id: null,
        created_at: '2026-05-08T10:00:00Z', source_verified: true,
        cost_usd: 0.5, duration_ms: 12000, run_status: 'completed',
        total_bytes: 2048, visibility: 'private',
      },
      {
        id: randomUUID(), user_id: userId, organization_id: null,
        created_at: '2026-05-07T08:00:00Z', source_verified: true,
        cost_usd: 0.1, duration_ms: 3000, run_status: 'failed',
        total_bytes: 1024, visibility: 'private',
      },
    ]);
    const { default: RunsList } = await import('@/app/dashboard/runs/page');
    const ui = await RunsList({ searchParams: Promise.resolve({}) });
    const { container } = render(ui);
    // Header present.
    expect(container.textContent).toMatch(/Runs/);
    // Both run statuses rendered.
    expect(container.textContent).toMatch(/completed/);
    expect(container.textContent).toMatch(/failed/);
  });

  it('test 17: /dashboard/runs/[runId] renders detail with mock manifest path', async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    currentUser = { id: userId };
    stub.seed('runs', [{
      id: runId, user_id: userId, organization_id: null,
      created_at: '2026-05-08T10:00:00Z', source_verified: true,
      cost_usd: 1.234, duration_ms: 8500, run_status: 'completed',
      total_bytes: 4096, visibility: 'private',
      events_chain_root: 'a'.repeat(64),
    }]);
    const { default: RunDetail } = await import('@/app/dashboard/runs/[runId]/page');
    const ui = await RunDetail({ params: Promise.resolve({ runId }) });
    const { container } = render(ui);
    expect(container.textContent).toMatch(/completed/);
    expect(container.textContent).toMatch(/1\.2340|1\.234/);
    expect(container.textContent).toContain('a'.repeat(64));
  });

  it('test 18: /dashboard/billing shows free-plan CTAs', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    currentUser = { id: userId, email: 'a@b.com' };
    stub.seed('memberships', [{
      organization_id: orgId, user_id: userId, role: 'owner', status: 'active',
    }]);
    stub.seed('entitlements', [{
      organization_id: orgId, plan: 'free',
      runs_per_month_cap: 100, storage_bytes_cap: 5 * 1024 * 1024 * 1024,
      stripe_subscription_status: null,
    }]);
    const { default: BillingPage } = await import('@/app/dashboard/billing/page');
    const ui = await BillingPage();
    const { container } = render(ui);
    expect(container.textContent).toMatch(/Billing/);
    expect(container.textContent).toMatch(/free/i);
    expect(container.textContent).toMatch(/Upgrade/i);
  });

  it('test 19: /runs/[runShareId] anon page renders for public run', async () => {
    const runId = randomUUID();
    publicRunRow = {
      id: runId,
      source_verified: true,
      events_chain_root: 'b'.repeat(64),
      total_bytes: 1024,
      cost_usd: 0.42,
      duration_ms: 5000,
      run_status: 'completed',
      created_at: '2026-05-08T12:00:00Z',
      visibility: 'public',
    };
    const { default: PublicRunPage } = await import('@/app/runs/[runShareId]/page');
    const ui = await PublicRunPage({ params: Promise.resolve({ runShareId: runId }) });
    const { container } = render(ui);
    expect(container.textContent).toMatch(/Public run/);
    expect(container.textContent).toMatch(/verified/);
    expect(container.textContent).toContain('b'.repeat(64));
  });

  it('test 19b: /runs/[runShareId] notFound when row is null', async () => {
    publicRunRow = null;
    const { default: PublicRunPage } = await import('@/app/runs/[runShareId]/page');
    let threw: Error | null = null;
    try {
      await PublicRunPage({ params: Promise.resolve({ runShareId: randomUUID() }) });
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).not.toBeNull();
    expect(notFoundCalls.length).toBeGreaterThan(0);
  });
});
