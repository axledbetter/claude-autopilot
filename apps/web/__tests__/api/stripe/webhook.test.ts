import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../_helpers/supabase-stub';
import { stripeStubState, resetStripeStubState, stripeMockFactory } from '../../_helpers/stripe-stub';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));

vi.mock('stripe', () => stripeMockFactory());

const { POST } = await import('@/app/api/stripe/webhook/route');
const { _resetBillingConfigForTests } = await import('@/lib/billing/plan-map');
const { _resetStripeClientForTests } = await import('@/lib/billing/stripe');

beforeEach(() => {
  stub.reset();
  resetStripeStubState();
  _resetBillingConfigForTests();
  _resetStripeClientForTests();
  process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'x'.repeat(20);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + 'x'.repeat(20);
  process.env.STRIPE_PRICE_SMALL_MONTHLY = 'price_small_monthly_xxxxxxxxxxxx';
  process.env.STRIPE_PRICE_SMALL_YEARLY = 'price_small_yearly_xxxxxxxxxxxxx';
  process.env.STRIPE_PRICE_MID_MONTHLY = 'price_mid_monthly_xxxxxxxxxxxxxx';
  process.env.STRIPE_PRICE_MID_YEARLY = 'price_mid_yearly_xxxxxxxxxxxxxxx';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function makeReq(event: object, sig = 'valid-test-signature'): Request {
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': sig,
    },
    body: JSON.stringify(event),
  });
}

function seedFreeOrgEntitlement(orgId: string): void {
  stub.seed('entitlements', [{
    organization_id: orgId,
    plan: 'free',
    runs_per_month_cap: 100,
    storage_bytes_cap: 5 * 1024 * 1024 * 1024,
    stripe_subscription_status: null,
    stripe_customer_id: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    payment_failed_at: null,
    last_stripe_event_at: null,
  }]);
}

describe('POST /api/stripe/webhook', () => {
  it('test 1: valid signature + new event → 200, entitlement updated', async () => {
    const orgId = randomUUID();
    const subId = 'sub_test_1';
    const customerId = 'cus_test_1';
    seedFreeOrgEntitlement(orgId);

    // Pre-stash subscription so the route's retrieve() succeeds.
    stripeStubState.subscriptions.set(subId, {
      id: subId,
      customer: customerId,
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      metadata: { organization_id: orgId },
      items: { data: [{ price: { id: process.env.STRIPE_PRICE_SMALL_MONTHLY! } }] },
    });

    const event = {
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'cs_test_1',
          customer: customerId,
          subscription: subId,
          client_reference_id: orgId,
          customer_email: 'a@b.com',
          metadata: { organization_id: orgId },
        },
      },
    };
    const res = await POST(makeReq(event));
    expect(res.status).toBe(200);

    // Verify billing_customers + entitlements rows updated.
    const customers = stub.tables.get('billing_customers') ?? [];
    expect(customers.length).toBe(1);
    expect(customers[0]!.stripe_customer_id).toBe(customerId);

    const ent = (stub.tables.get('entitlements') ?? [])[0]!;
    expect(ent.plan).toBe('small');
    expect(ent.stripe_customer_id).toBe(customerId);
    expect(ent.stripe_subscription_status).toBe('active');
    expect(ent.runs_per_month_cap).toBe(1000);
  });

  it('test 2: invalid signature → 400', async () => {
    const event = { id: 'evt_test_2', type: 'invoice.payment_failed', created: 1, data: { object: {} } };
    const res = await POST(makeReq(event, 'bogus-sig'));
    expect(res.status).toBe(400);
  });

  it('test 3: duplicate event.id (status=completed) → 200 no-op', async () => {
    stub.seed('stripe_webhook_events', [{
      id: 'evt_test_3', type: 'checkout.session.completed', payload: {},
      status: 'completed',
      attempt_count: 1,
      processing_started_at: new Date().toISOString(),
      locked_until: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }]);
    const event = { id: 'evt_test_3', type: 'checkout.session.completed', created: 1, data: { object: {} } };
    const res = await POST(makeReq(event));
    expect(res.status).toBe(200);
  });

  it('test 4: duplicate event.id (status=processing, lease held) → 409', async () => {
    stub.seed('stripe_webhook_events', [{
      id: 'evt_test_4', type: 'checkout.session.completed', payload: {},
      status: 'processing',
      attempt_count: 1,
      processing_started_at: new Date().toISOString(),
      locked_until: new Date(Date.now() + 30_000).toISOString(),  // future
    }]);
    const event = { id: 'evt_test_4', type: 'checkout.session.completed', created: 1, data: { object: {} } };
    const res = await POST(makeReq(event));
    expect(res.status).toBe(409);
  });

  it('test 5: duplicate event.id (status=failed) → re-processes from processing', async () => {
    const orgId = randomUUID();
    seedFreeOrgEntitlement(orgId);
    stub.seed('billing_customers', [{
      organization_id: orgId,
      stripe_customer_id: 'cus_test_5',
      email: null,
      created_at: new Date().toISOString(),
    }]);
    stub.seed('stripe_webhook_events', [{
      id: 'evt_test_5', type: 'invoice.payment_failed', payload: {},
      status: 'failed',
      attempt_count: 1,
      error: 'previous',
      processing_started_at: new Date(Date.now() - 120_000).toISOString(),
      locked_until: new Date(Date.now() - 60_000).toISOString(),
    }]);
    const event = {
      id: 'evt_test_5',
      type: 'invoice.payment_failed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'in_1', customer: 'cus_test_5', subscription: null } },
    };
    const res = await POST(makeReq(event));
    expect(res.status).toBe(200);
    const row = (stub.tables.get('stripe_webhook_events') ?? []).find((r) => r.id === 'evt_test_5')!;
    expect(row.status).toBe('completed');
    expect(row.attempt_count).toBe(2);
  });

  it('test 6: customer.subscription.updated resolves by stripe_customer_id when no metadata', async () => {
    const orgId = randomUUID();
    seedFreeOrgEntitlement(orgId);
    stub.seed('billing_customers', [{
      organization_id: orgId,
      stripe_customer_id: 'cus_test_6',
      email: null,
      created_at: new Date().toISOString(),
    }]);

    const event = {
      id: 'evt_test_6',
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'sub_6',
          customer: 'cus_test_6',
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: null,
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          metadata: null,
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_SMALL_YEARLY! } }] },
        },
      },
    };
    const res = await POST(makeReq(event));
    expect(res.status).toBe(200);
    const ent = (stub.tables.get('entitlements') ?? [])[0]!;
    expect(ent.plan).toBe('small');
  });

  it('test 7: customer.subscription.deleted → cancel_at stamped, last_stripe_event_at advances', async () => {
    const orgId = randomUUID();
    seedFreeOrgEntitlement(orgId);
    stub.seed('billing_customers', [{
      organization_id: orgId,
      stripe_customer_id: 'cus_test_7',
      email: null,
      created_at: new Date().toISOString(),
    }]);
    const cancelAtEpoch = Math.floor(Date.now() / 1000) + 1000;
    const event = {
      id: 'evt_test_7',
      type: 'customer.subscription.deleted',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'sub_7',
          customer: 'cus_test_7',
          status: 'canceled',
          cancel_at_period_end: true,
          cancel_at: cancelAtEpoch,
          current_period_end: cancelAtEpoch,
          metadata: { organization_id: orgId },
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_SMALL_MONTHLY! } }] },
        },
      },
    };
    const res = await POST(makeReq(event));
    expect(res.status).toBe(200);
    const ent = (stub.tables.get('entitlements') ?? [])[0]!;
    expect(ent.cancel_at_period_end).toBe(true);
    expect(ent.cancel_at).toBeTruthy();
    expect(ent.stripe_subscription_status).toBe('canceled');
    expect(ent.last_stripe_event_at).toBeTruthy();
  });

  it('test 8: invoice.payment_failed stamps payment_failed_at without immediate downgrade', async () => {
    const orgId = randomUUID();
    stub.seed('entitlements', [{
      organization_id: orgId,
      plan: 'small',
      runs_per_month_cap: 1000,
      storage_bytes_cap: 50 * 1024 * 1024 * 1024,
      stripe_subscription_status: 'past_due',
      stripe_customer_id: 'cus_test_8',
      current_period_end: new Date(Date.now() + 30 * 86400_000).toISOString(),
      cancel_at_period_end: false,
      cancel_at: null,
      payment_failed_at: null,
      last_stripe_event_at: null,
    }]);
    stub.seed('billing_customers', [{
      organization_id: orgId,
      stripe_customer_id: 'cus_test_8',
      email: null,
      created_at: new Date().toISOString(),
    }]);
    const event = {
      id: 'evt_test_8',
      type: 'invoice.payment_failed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: { id: 'in_8', customer: 'cus_test_8', subscription: null },
      },
    };
    const res = await POST(makeReq(event));
    expect(res.status).toBe(200);
    const ent = (stub.tables.get('entitlements') ?? [])[0]!;
    expect(ent.payment_failed_at).toBeTruthy();
    expect(ent.plan).toBe('small');     // not downgraded yet
  });

  it('test 9 (bugbot MEDIUM): subscription.updated with status=active clears stale payment_failed_at', async () => {
    // Org has a stale payment_failed_at from a prior failure that has
    // since been resolved. A subsequent customer.subscription.updated with
    // status=active must clear the timestamp; otherwise checkEntitlement's
    // 7-day grace falls back to free.
    const orgId = randomUUID();
    const subId = 'sub_test_9';
    const oldFailedAt = new Date(Date.now() - 6 * 86400_000).toISOString();
    stub.seed('entitlements', [{
      organization_id: orgId,
      plan: 'small',
      runs_per_month_cap: 1000,
      storage_bytes_cap: 50 * 1024 * 1024 * 1024,
      stripe_subscription_status: 'past_due',
      stripe_customer_id: 'cus_test_9',
      stripe_subscription_id: subId,
      current_period_end: new Date(Date.now() + 30 * 86400_000).toISOString(),
      cancel_at_period_end: false,
      cancel_at: null,
      payment_failed_at: oldFailedAt,    // stale; would expire at day 7
      last_stripe_event_at: null,
    }]);
    stub.seed('billing_customers', [{
      organization_id: orgId,
      stripe_customer_id: 'cus_test_9',
      email: null,
      created_at: new Date().toISOString(),
    }]);
    const event = {
      id: 'evt_test_9',
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: subId,
          customer: 'cus_test_9',
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: null,
          current_period_end: Math.floor((Date.now() + 30 * 86400_000) / 1000),
          items: { data: [{ price: { id: 'price_small_monthly_xxxxxxxxxxxx' } }] },
          metadata: { organization_id: orgId },
        },
      },
    };
    const res = await POST(makeReq(event));
    expect(res.status).toBe(200);
    const ent = (stub.tables.get('entitlements') ?? []).find((e) => e.organization_id === orgId)!;
    expect(ent.payment_failed_at).toBeNull();
    expect(ent.stripe_subscription_status).toBe('active');
  });
});
