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

const { POST } = await import('@/app/api/dashboard/billing/portal/route');
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

function req(body: object): Request {
  return new Request('http://x/api/dashboard/billing/portal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/dashboard/billing/portal', () => {
  it('test 13: admin of org with billing_customers row → 200 with portal URL', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    const customerId = 'cus_portal_1';
    currentUser = { id: userId };
    // Pre-stash customer in stripe stub so portal create succeeds.
    stripeStubState.customers.set(customerId, { id: customerId });
    stub.seed('memberships', [{
      organization_id: orgId, user_id: userId, role: 'admin', status: 'active',
    }]);
    stub.seed('billing_customers', [{
      organization_id: orgId,
      stripe_customer_id: customerId,
      email: 'a@b.com',
      created_at: new Date().toISOString(),
    }]);
    const r = await POST(req({ organizationId: orgId }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toMatch(/^https:\/\/billing\.stripe\.com\/p\/session\//);
  });

  it('test 14: org with no billing_customers row → 404', async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    currentUser = { id: userId };
    stub.seed('memberships', [{
      organization_id: orgId, user_id: userId, role: 'owner', status: 'active',
    }]);
    const r = await POST(req({ organizationId: orgId }));
    expect(r.status).toBe(404);
  });

  it('test 15: anon → 401', async () => {
    const r = await POST(req({ organizationId: randomUUID() }));
    expect(r.status).toBe(401);
  });
});
