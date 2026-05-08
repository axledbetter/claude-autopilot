import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));

const { checkEntitlement } = await import('@/lib/billing/check-entitlement');
const { _resetBillingConfigForTests } = await import('@/lib/billing/plan-map');

beforeEach(() => {
  stub.reset();
  _resetBillingConfigForTests();
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
  (process.env as Record<string, string>).NODE_ENV = 'test';
});

const FIVE_GIB = 5 * 1024 * 1024 * 1024;
const FIFTY_GIB = 50 * 1024 * 1024 * 1024;

function nowIso(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86400_000).toISOString();
}

function seedFreeOrg(orgId: string): void {
  stub.seed('entitlements', [{
    organization_id: orgId,
    plan: 'free',
    runs_per_month_cap: 100,
    storage_bytes_cap: FIVE_GIB,
    stripe_subscription_status: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    payment_failed_at: null,
    last_stripe_event_at: null,
  }]);
}

function seedSmallOrg(orgId: string, opts: {
  status?: string | null;
  currentPeriodEnd?: string | null;
  cancelAt?: string | null;
  paymentFailedAt?: string | null;
} = {}): void {
  stub.seed('entitlements', [{
    organization_id: orgId,
    plan: 'small',
    runs_per_month_cap: 1000,
    storage_bytes_cap: FIFTY_GIB,
    stripe_subscription_status: opts.status ?? 'active',
    current_period_end: opts.currentPeriodEnd ?? nowIso(30),
    cancel_at_period_end: false,
    cancel_at: opts.cancelAt ?? null,
    payment_failed_at: opts.paymentFailedAt ?? null,
    last_stripe_event_at: null,
  }]);
}

function seedEnterpriseOrg(orgId: string): void {
  stub.seed('entitlements', [{
    organization_id: orgId,
    plan: 'enterprise',
    runs_per_month_cap: null,
    storage_bytes_cap: null,
    stripe_subscription_status: 'active',
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    payment_failed_at: null,
    last_stripe_event_at: null,
  }]);
}

function seedRuns(count: number, opts: { orgId?: string | null; userId: string; bytesEach?: number }): void {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: randomUUID(),
      user_id: opts.userId,
      organization_id: opts.orgId ?? null,
      created_at: nowIso(0),
      total_bytes: opts.bytesEach ?? 0,
      deleted_at: null,
    });
  }
  stub.seed('runs', rows);
}

describe('checkEntitlement', () => {
  it('test 16: free tier (personal) under cap → exceeded=false', async () => {
    const userId = randomUUID();
    const result = await checkEntitlement({ organizationId: null, userId, expectedBytes: 1024 });
    expect(result.exceeded).toBe(false);
    expect(result.effectivePlan).toBe('free');
  });

  it('test 17: free tier over runs cap → exceeded=true, kind=runs_per_month', async () => {
    const userId = randomUUID();
    seedRuns(101, { userId });   // 101 > 100 → reject
    const result = await checkEntitlement({ organizationId: null, userId, expectedBytes: 0 });
    expect(result.exceeded).toBe(true);
    expect(result.kind).toBe('runs_per_month');
    expect(result.current).toBe(101);
    expect(result.max).toBe(100);
  });

  it('test 18: free tier over storage cap → exceeded=true, kind=storage_bytes', async () => {
    const userId = randomUUID();
    // 4 GiB used + 2 GiB requested > 5 GiB cap.
    seedRuns(1, { userId, bytesEach: 4 * 1024 * 1024 * 1024 });
    const result = await checkEntitlement({
      organizationId: null,
      userId,
      expectedBytes: 2 * 1024 * 1024 * 1024,
    });
    expect(result.exceeded).toBe(true);
    expect(result.kind).toBe('storage_bytes');
    expect(result.max).toBe(FIVE_GIB);
  });

  it('test 19: org Small under cap → exceeded=false', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    seedSmallOrg(orgId);
    seedRuns(50, { orgId, userId });
    const result = await checkEntitlement({ organizationId: orgId, userId, expectedBytes: 0 });
    expect(result.exceeded).toBe(false);
    expect(result.effectivePlan).toBe('small');
  });

  it('test 20: org Small over runs (whole-org count) — exceeded=true', async () => {
    const orgId = randomUUID();
    const u1 = randomUUID(); const u2 = randomUUID();
    seedSmallOrg(orgId);
    // 2 users in same org, total runs > 1000.
    seedRuns(600, { orgId, userId: u1 });
    seedRuns(401, { orgId, userId: u2 });
    const result = await checkEntitlement({ organizationId: orgId, userId: u1, expectedBytes: 0 });
    expect(result.exceeded).toBe(true);
    expect(result.kind).toBe('runs_per_month');
    expect(result.current).toBe(1001);
    expect(result.max).toBe(1000);
  });

  it('test 21: org Small over storage (retained bytes, not monthly)', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    seedSmallOrg(orgId);
    // Single 49 GiB run + 2 GiB requested > 50 GiB cap.
    seedRuns(1, { orgId, userId, bytesEach: 49 * 1024 * 1024 * 1024 });
    const result = await checkEntitlement({
      organizationId: orgId,
      userId,
      expectedBytes: 2 * 1024 * 1024 * 1024,
    });
    expect(result.exceeded).toBe(true);
    expect(result.kind).toBe('storage_bytes');
  });

  it('test 22: enterprise plan with NULL caps → exceeded=false always', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    seedEnterpriseOrg(orgId);
    // Pile on a ridiculous amount of runs/bytes.
    seedRuns(50000, { orgId, userId, bytesEach: 1024 * 1024 * 1024 });
    const result = await checkEntitlement({
      organizationId: orgId,
      userId,
      expectedBytes: 1024 * 1024 * 1024 * 1024,
    });
    expect(result.exceeded).toBe(false);
    expect(result.effectivePlan).toBe('enterprise');
    expect(result.kind).toBe('none');
  });

  it('test 23: subscription status=canceled AND past current_period_end → falls through to free', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    seedSmallOrg(orgId, {
      status: 'canceled',
      currentPeriodEnd: nowIso(-1), // 1 day in past
    });
    // 101 runs would still pass under small cap (1000) but fail under free (100).
    seedRuns(101, { orgId, userId });
    const result = await checkEntitlement({ organizationId: orgId, userId, expectedBytes: 0 });
    expect(result.exceeded).toBe(true);
    expect(result.effectivePlan).toBe('free');
    expect(result.max).toBe(100);
  });

  it('test 24: cancel_at_period_end=true AND BEFORE current_period_end → still honors paid cap', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    seedSmallOrg(orgId, {
      status: 'active',
      currentPeriodEnd: nowIso(30),
      cancelAt: nowIso(30), // future
    });
    // 500 runs, under small cap of 1000.
    seedRuns(500, { orgId, userId });
    const result = await checkEntitlement({ organizationId: orgId, userId, expectedBytes: 0 });
    expect(result.exceeded).toBe(false);
    expect(result.effectivePlan).toBe('small');
    expect(result.max).toBe(1000);
  });

  it('test 25: payment_failed_at within 7-day grace → still honors paid cap', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    seedSmallOrg(orgId, {
      status: 'past_due',
      paymentFailedAt: nowIso(-3), // 3 days ago, within grace
    });
    // 500 runs, under small cap of 1000.
    seedRuns(500, { orgId, userId });
    const result = await checkEntitlement({ organizationId: orgId, userId, expectedBytes: 0 });
    expect(result.exceeded).toBe(false);
    expect(result.effectivePlan).toBe('small');
  });
});
