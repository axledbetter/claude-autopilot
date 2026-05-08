import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../_helpers/supabase-stub';
import { stripeStubState, resetStripeStubState, stripeMockFactory } from '../../../_helpers/stripe-stub';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));
let currentUser: { id: string; email?: string } | null = null;
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined }),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));
vi.mock('stripe', () => stripeMockFactory());

const { POST } = await import('@/app/api/dashboard/billing/checkout/route');
const { _resetBillingConfigForTests } = await import('@/lib/billing/plan-map');
const { _resetStripeClientForTests } = await import('@/lib/billing/stripe');

beforeEach(() => {
  stub.reset();
  resetStripeStubState();
  _resetBillingConfigForTests();
  _resetStripeClientForTests();
  currentUser = null;
  process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'x'.repeat(20);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + 'x'.repeat(20);
  process.env.STRIPE_PRICE_SMALL_MONTHLY = 'price_small_monthly_xxxxxxxxxxxx';
  process.env.STRIPE_PRICE_SMALL_YEARLY = 'price_small_yearly_xxxxxxxxxxxxx';
  process.env.STRIPE_PRICE_MID_MONTHLY = 'price_mid_monthly_xxxxxxxxxxxxxx';
  process.env.STRIPE_PRICE_MID_YEARLY = 'price_mid_yearly_xxxxxxxxxxxxxxx';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
});

function req(body: object, headers: Record<string, string> = {}): Request {
  return new Request('http://x/api/dashboard/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/dashboard/billing/checkout', () => {
  it('test 9: owner of org → 200 with Stripe URL', async () => {
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
    const r = await POST(req({ organizationId: orgId, tier: 'small', interval: 'monthly' }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(stripeStubState.checkoutIdempotencyKeys).toContain(`${orgId}:small:monthly`);
  });

  it('test 10: member (not admin/owner) → 403', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    currentUser = { id: userId };
    stub.seed('memberships', [{
      organization_id: orgId, user_id: userId, role: 'member', status: 'active',
    }]);
    const r = await POST(req({ organizationId: orgId, tier: 'small', interval: 'monthly' }));
    expect(r.status).toBe(403);
  });

  it('test 11: anon → 401', async () => {
    const r = await POST(req({ organizationId: randomUUID(), tier: 'small', interval: 'monthly' }));
    expect(r.status).toBe(401);
  });

  it('test 12: org already on paid plan → 409', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    currentUser = { id: userId, email: 'a@b.com' };
    stub.seed('memberships', [{
      organization_id: orgId, user_id: userId, role: 'admin', status: 'active',
    }]);
    stub.seed('entitlements', [{
      organization_id: orgId, plan: 'small',
      runs_per_month_cap: 1000, storage_bytes_cap: 50 * 1024 * 1024 * 1024,
      stripe_subscription_status: 'active',
    }]);
    const r = await POST(req({ organizationId: orgId, tier: 'mid', interval: 'monthly' }));
    expect(r.status).toBe(409);
  });

  it('bugbot MEDIUM: 409 also for trialing/past_due/incomplete (not just active)', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    currentUser = { id: userId, email: 'a@b.com' };
    stub.seed('memberships', [{
      organization_id: orgId, user_id: userId, role: 'admin', status: 'active',
    }]);
    for (const status of ['trialing', 'past_due', 'incomplete']) {
      stub.tables.set('entitlements', []);
      stub.seed('entitlements', [{
        organization_id: orgId, plan: 'small',
        runs_per_month_cap: 1000, storage_bytes_cap: 50 * 1024 * 1024 * 1024,
        stripe_subscription_status: status,
      }]);
      const r = await POST(req({ organizationId: orgId, tier: 'mid', interval: 'monthly' }));
      expect(r.status, `status=${status}`).toBe(409);
    }
  });

  it('test 28 (checkout): mismatched Origin → 403', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    currentUser = { id: userId, email: 'a@b.com' };
    stub.seed('memberships', [{
      organization_id: orgId, user_id: userId, role: 'owner', status: 'active',
    }]);
    const r = await POST(req(
      { organizationId: orgId, tier: 'small', interval: 'monthly' },
      { origin: 'https://attacker.example' },
    ));
    expect(r.status).toBe(403);
  });

  it('bugbot MEDIUM: terminal statuses (canceled/unpaid/incomplete_expired) allow new checkout', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    currentUser = { id: userId, email: 'a@b.com' };
    stub.seed('memberships', [{
      organization_id: orgId, user_id: userId, role: 'admin', status: 'active',
    }]);
    for (const status of ['canceled', 'unpaid', 'incomplete_expired']) {
      stub.tables.set('entitlements', []);
      stub.seed('entitlements', [{
        organization_id: orgId, plan: 'small',
        runs_per_month_cap: 1000, storage_bytes_cap: 50 * 1024 * 1024 * 1024,
        stripe_subscription_status: status,
      }]);
      const r = await POST(req({ organizationId: orgId, tier: 'mid', interval: 'monthly' }));
      expect([200, 201], `status=${status}`).toContain(r.status);
    }
  });
});
