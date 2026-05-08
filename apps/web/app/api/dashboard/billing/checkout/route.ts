// POST /api/dashboard/billing/checkout — Phase 3.
//
// Auth: Supabase session cookie. Caller must be a member of the requested
// organization with role IN ('owner','admin') AND status='active'.
//
// Body: { organizationId, tier: 'small'|'mid', interval: 'monthly'|'yearly' }.
//
// Stripe idempotency (codex pass 2 WARNING): pass idempotencyKey
// '${organizationId}:${tier}:${interval}' to checkout.sessions.create — two
// concurrent admin clicks for the same combination get the same Checkout
// Session URL. Different combos still get independent sessions.
//
// Customer reuse (codex pass 2 WARNING): if billing_customers row exists
// for the org (previously paid + canceled), pass `customer: stripe_customer_id`
// to Checkout instead of `customer_email`.
import { NextResponse } from 'next/server';
import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getStripeClient } from '@/lib/billing/stripe';
import { loadBillingConfig, PLAN_MAP, type Tier, type Interval } from '@/lib/billing/plan-map';
import { createServiceRoleClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';

interface Body {
  organizationId: string;
  tier: Tier;
  interval: Interval;
}

async function resolveSession(): Promise<{ userId: string; email: string | null } | null> {
  try {
    const cookieStore = await cookies();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return null;
    const ssr = createSsrServerClient(url, anon, {
      cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await ssr.auth.getUser();
    if (!user) return null;
    return { userId: user.id, email: user.email ?? null };
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 422 });
  }
  if (!body?.organizationId || (body.tier !== 'small' && body.tier !== 'mid')
      || (body.interval !== 'monthly' && body.interval !== 'yearly')) {
    return NextResponse.json({ error: 'organizationId + tier + interval required' }, { status: 422 });
  }

  const session = await resolveSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const supabase = createServiceRoleClient();

  // Verify membership role.
  const { data: membership } = await supabase.from('memberships')
    .select('role, status')
    .eq('organization_id', body.organizationId)
    .eq('user_id', session.userId)
    .eq('status', 'active')
    .maybeSingle();
  const m = membership as { role: string; status: string } | null;
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Already-paid guard.
  const { data: existingEnt } = await supabase.from('entitlements')
    .select('plan, stripe_subscription_status')
    .eq('organization_id', body.organizationId)
    .maybeSingle();
  const ent = existingEnt as { plan: string; stripe_subscription_status: string | null } | null;
  if (ent && ent.plan !== 'free' && ent.stripe_subscription_status === 'active') {
    return NextResponse.json({ error: 'org already on a paid subscription' }, { status: 409 });
  }

  // Look up persisted Stripe customer (reuse if present).
  const { data: customerRow } = await supabase.from('billing_customers')
    .select('stripe_customer_id')
    .eq('organization_id', body.organizationId)
    .maybeSingle();
  const stripeCustomerId = (customerRow as { stripe_customer_id: string } | null)?.stripe_customer_id ?? null;

  const config = loadBillingConfig();
  const priceId = PLAN_MAP[body.tier][body.interval].priceId;

  const successUrl = `${config.AUTOPILOT_PUBLIC_BASE_URL}/dashboard/billing/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${config.AUTOPILOT_PUBLIC_BASE_URL}/dashboard/billing`;

  const stripe = getStripeClient();
  const checkout = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: body.organizationId,
    metadata: { organization_id: body.organizationId, tier: body.tier, interval: body.interval },
    subscription_data: {
      metadata: { organization_id: body.organizationId, tier: body.tier, interval: body.interval },
    },
    ...(stripeCustomerId
      ? { customer: stripeCustomerId }
      : (session.email ? { customer_email: session.email } : {})),
  } as never, {
    idempotencyKey: `${body.organizationId}:${body.tier}:${body.interval}`,
  });

  return NextResponse.json({ url: checkout.url }, { status: 200 });
}
