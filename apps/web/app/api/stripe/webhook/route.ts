// POST /api/stripe/webhook — Phase 3 Stripe webhook handler.
//
// Signature verification reads RAW body via `await req.text()` BEFORE any
// JSON parsing — Stripe signs the raw payload and any normalization
// invalidates the HMAC.
//
// Idempotency uses claim/lease/complete pattern (codex pass 2 CRITICAL #1):
//   - INSERT a row with status='processing' + locked_until=NOW()+60s.
//   - Duplicate event.id with status='completed' → 200 no-op.
//   - Duplicate with status='processing' AND locked_until>NOW() → 409 (Stripe retries).
//   - Duplicate with status='processing' AND locked_until<=NOW() → atomic reclaim, re-process.
//   - Duplicate with status='failed' → reset and re-process (attempt_count++).
//
// Every entitlement-mutating handler MUST compare event.created vs the
// org's persisted `last_stripe_event_at` watermark and SKIP the mutation
// when the event is older (codex plan-pass CRITICAL #2). This protects
// against out-of-order delivery (Stripe doesn't guarantee order).
//
// Runtime: Node — Edge runtime can't reliably do raw-body Stripe sig verify.
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripeClient } from '@/lib/billing/stripe';
import { loadBillingConfig, tierForPriceId, capsForTier } from '@/lib/billing/plan-map';
import { createServiceRoleClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';

type Supabase = ReturnType<typeof createServiceRoleClient>;

const LEASE_MS = 60_000;

export async function POST(req: Request): Promise<Response> {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing signature', { status: 400 });

  const config = loadBillingConfig();
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripeClient().webhooks.constructEvent(
      rawBody,
      sig,
      config.STRIPE_WEBHOOK_SECRET,
    ) as Stripe.Event;
  } catch (err) {
    return new Response(
      `signature verification failed: ${(err as Error).message}`,
      { status: 400 },
    );
  }

  const supabase = createServiceRoleClient();

  // Claim or detect duplicate.
  const { error: insertErr } = await supabase.from('stripe_webhook_events').insert({
    id: event.id,
    type: event.type,
    payload: event,
  });

  if (insertErr) {
    if (!/duplicate|unique/i.test(insertErr.message)) {
      return new Response('insert error', { status: 500 });
    }
    const { data } = await supabase.from('stripe_webhook_events')
      .select('status, locked_until, attempt_count')
      .eq('id', event.id)
      .maybeSingle();
    if (!data) return new Response('row missing', { status: 500 });
    const row = data as { status: string; locked_until: string; attempt_count: number };

    if (row.status === 'completed') {
      return new Response('ok', { status: 200 });
    }
    if (row.status === 'processing') {
      if (new Date(row.locked_until) > new Date()) {
        return new Response('lease held', { status: 409 });
      }
      // Stale lease — reclaim atomically.
      const { data: claimed } = await supabase.from('stripe_webhook_events').update({
        attempt_count: row.attempt_count + 1,
        processing_started_at: new Date().toISOString(),
        locked_until: new Date(Date.now() + LEASE_MS).toISOString(),
        error: null,
      })
        .eq('id', event.id)
        .eq('status', 'processing')
        .lte('locked_until', new Date().toISOString())
        .select('id')
        .maybeSingle();
      if (!claimed) return new Response('lease race lost', { status: 409 });
    } else if (row.status === 'failed') {
      // Codex plan-pass NOTE — increment attempt_count on failed retries too.
      await supabase.from('stripe_webhook_events').update({
        status: 'processing',
        error: null,
        attempt_count: row.attempt_count + 1,
        processing_started_at: new Date().toISOString(),
        locked_until: new Date(Date.now() + LEASE_MS).toISOString(),
      }).eq('id', event.id);
    }
  }

  try {
    await dispatch(event, supabase);
    await supabase.from('stripe_webhook_events').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', event.id);
    return new Response('ok', { status: 200 });
  } catch (err) {
    await supabase.from('stripe_webhook_events').update({
      status: 'failed',
      error: (err as Error).message,
    }).eq('id', event.id);
    return new Response('handler failed', { status: 500 });
  }
}

async function dispatch(event: Stripe.Event, supabase: Supabase): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(event, supabase);
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return handleSubscriptionEvent(event, supabase);
    case 'invoice.payment_failed':
      return handlePaymentFailed(event, supabase);
    default:
      return; // unhandled events still mark completed
  }
}

interface CheckoutSessionShape {
  id: string;
  customer: string | null;
  subscription: string | null;
  client_reference_id: string | null;
  customer_email: string | null;
  metadata: Record<string, string> | null;
}

interface SubscriptionShape {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  current_period_end: number | null;
  metadata: Record<string, string> | null;
  items: { data: Array<{ price: { id: string } }> };
}

interface InvoiceShape {
  id: string;
  customer: string;
  subscription: string | null;
}

async function handleCheckoutCompleted(event: Stripe.Event, supabase: Supabase): Promise<void> {
  const session = event.data.object as unknown as CheckoutSessionShape;
  const orgId = session.client_reference_id ?? session.metadata?.organization_id ?? null;
  if (!orgId) {
    throw new Error(`checkout.session.completed missing organization_id (session=${session.id})`);
  }
  const customerId = session.customer;
  if (!customerId) {
    throw new Error(`checkout.session.completed missing customer (session=${session.id})`);
  }

  // Persist the customer mapping (idempotent upsert).
  const { data: existingCustomer } = await supabase.from('billing_customers')
    .select('organization_id')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!existingCustomer) {
    await supabase.from('billing_customers').insert({
      organization_id: orgId,
      stripe_customer_id: customerId,
      email: session.customer_email ?? null,
    });
  }

  if (!session.subscription) {
    // Non-subscription checkout (e.g. setup mode) — nothing more to do.
    await stampWatermark(supabase, orgId, event);
    return;
  }
  // Pull authoritative subscription state.
  const sub = await getStripeClient().subscriptions.retrieve(session.subscription) as unknown as SubscriptionShape;
  await applySubscriptionToEntitlement(orgId, customerId, sub, event, supabase);
}

async function handleSubscriptionEvent(event: Stripe.Event, supabase: Supabase): Promise<void> {
  const sub = event.data.object as unknown as SubscriptionShape;
  const orgId = await resolveOrgFromSubscription(sub, supabase);
  if (!orgId) {
    // Could not map — surface via the failure pathway so operator sees it.
    throw new Error(`subscription event ${sub.id} could not resolve organization_id`);
  }
  await applySubscriptionToEntitlement(orgId, sub.customer, sub, event, supabase);
}

async function handlePaymentFailed(event: Stripe.Event, supabase: Supabase): Promise<void> {
  const inv = event.data.object as unknown as InvoiceShape;
  const orgId = await resolveOrgFromCustomerOrSubscription(inv.customer, inv.subscription, supabase);
  if (!orgId) {
    throw new Error(`invoice.payment_failed could not resolve organization_id (invoice=${inv.id})`);
  }
  // Watermark check: skip if we've already processed a newer event.
  const skip = await isStaleEvent(supabase, orgId, event);
  if (skip) return;
  await supabase.from('entitlements').update({
    payment_failed_at: new Date(event.created * 1000).toISOString(),
    last_stripe_event_at: new Date(event.created * 1000).toISOString(),
  }).eq('organization_id', orgId);
}

async function applySubscriptionToEntitlement(
  orgId: string,
  customerId: string,
  sub: SubscriptionShape,
  event: Stripe.Event,
  supabase: Supabase,
): Promise<void> {
  if (await isStaleEvent(supabase, orgId, event)) return;

  // Resolve plan from price.
  const priceId = sub.items?.data?.[0]?.price?.id;
  let plan: 'free' | 'small' | 'mid' = 'free';
  let runsCap = 100;
  let storageCap = 5 * 1024 * 1024 * 1024;
  if (priceId) {
    const t = tierForPriceId(priceId);
    if (t) {
      plan = t.tier;
      const caps = capsForTier(t.tier);
      runsCap = caps.runsPerMonthCap;
      storageCap = caps.storageBytesCap;
    }
  }

  const eventTime = new Date(event.created * 1000).toISOString();
  await supabase.from('entitlements').update({
    plan,
    runs_per_month_cap: runsCap,
    storage_bytes_cap: storageCap,
    stripe_customer_id: customerId,
    stripe_subscription_status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
    cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
    last_stripe_event_at: eventTime,
  }).eq('organization_id', orgId);
}

async function resolveOrgFromSubscription(
  sub: SubscriptionShape,
  supabase: Supabase,
): Promise<string | null> {
  if (sub.metadata?.organization_id) return sub.metadata.organization_id;
  // Look up by customer.
  const { data } = await supabase.from('billing_customers')
    .select('organization_id')
    .eq('stripe_customer_id', sub.customer)
    .maybeSingle();
  return (data as { organization_id: string } | null)?.organization_id ?? null;
}

async function resolveOrgFromCustomerOrSubscription(
  customerId: string | null,
  subId: string | null,
  supabase: Supabase,
): Promise<string | null> {
  if (subId) {
    try {
      const sub = await getStripeClient().subscriptions.retrieve(subId) as unknown as SubscriptionShape;
      const fromMeta = sub.metadata?.organization_id;
      if (fromMeta) return fromMeta;
    } catch {
      // fall through to customer lookup
    }
  }
  if (!customerId) return null;
  const { data } = await supabase.from('billing_customers')
    .select('organization_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return (data as { organization_id: string } | null)?.organization_id ?? null;
}

async function isStaleEvent(
  supabase: Supabase,
  orgId: string,
  event: Stripe.Event,
): Promise<boolean> {
  const { data } = await supabase.from('entitlements')
    .select('last_stripe_event_at')
    .eq('organization_id', orgId)
    .maybeSingle();
  const watermark = (data as { last_stripe_event_at: string | null } | null)?.last_stripe_event_at;
  if (!watermark) return false;
  return new Date(watermark) >= new Date(event.created * 1000);
}

async function stampWatermark(supabase: Supabase, orgId: string, event: Stripe.Event): Promise<void> {
  if (await isStaleEvent(supabase, orgId, event)) return;
  await supabase.from('entitlements').update({
    last_stripe_event_at: new Date(event.created * 1000).toISOString(),
  }).eq('organization_id', orgId);
}
