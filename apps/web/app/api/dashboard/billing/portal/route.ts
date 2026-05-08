// POST /api/dashboard/billing/portal — Phase 3.
//
// Auth: Supabase session cookie. Caller must be admin/owner of the org.
//
// Body: { organizationId: string }.
// Returns: { url: string } pointing to Stripe Customer Portal session.
//
// 404 when no billing_customers row exists (org never paid → no portal yet).
import { NextResponse } from 'next/server';
import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getStripeClient } from '@/lib/billing/stripe';
import { loadBillingConfig } from '@/lib/billing/plan-map';
import { createServiceRoleClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';

interface Body {
  organizationId: string;
}

async function resolveSession(): Promise<{ userId: string } | null> {
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
    return { userId: user.id };
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
  if (!body?.organizationId) {
    return NextResponse.json({ error: 'organizationId required' }, { status: 422 });
  }

  const session = await resolveSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const supabase = createServiceRoleClient();

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

  const { data: customer } = await supabase.from('billing_customers')
    .select('stripe_customer_id')
    .eq('organization_id', body.organizationId)
    .maybeSingle();
  const c = customer as { stripe_customer_id: string } | null;
  if (!c) {
    return NextResponse.json({ error: 'no billing customer for organization' }, { status: 404 });
  }

  const config = loadBillingConfig();
  const portal = await getStripeClient().billingPortal.sessions.create({
    customer: c.stripe_customer_id,
    return_url: `${config.AUTOPILOT_PUBLIC_BASE_URL}/dashboard/billing`,
  });

  return NextResponse.json({ url: portal.url }, { status: 200 });
}
