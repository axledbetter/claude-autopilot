// /dashboard/billing/success — Phase 4. Stripe Checkout return landing.
// Polls /api/dashboard/me until entitlements update; max 10 attempts × 2s.

import SuccessPoller from './_components/SuccessPoller';

export const dynamic = 'force-dynamic';

export default async function BillingSuccessPage(
  { searchParams }: { searchParams: Promise<{ session_id?: string }> },
): Promise<React.ReactElement> {
  const params = await searchParams;
  const sessionId = params.session_id ?? null;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 max-w-md mx-auto text-center">
      <h1 className="text-2xl font-bold mb-4">Thanks — finalizing your upgrade</h1>
      <p className="opacity-70 mb-8">
        Stripe has accepted your payment. We're waiting for the webhook to
        update your account; this normally takes a few seconds.
      </p>
      <SuccessPoller sessionId={sessionId} />
    </main>
  );
}
