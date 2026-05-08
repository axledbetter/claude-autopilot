// Stripe client wrapper with test seam.
//
// Lazy-construct the SDK so tests using `vi.mock('stripe', ...)` can swap
// the constructor before this module captures it. `_resetStripeClientForTests`
// + `vi.mock` together give complete control over Stripe behavior in tests.
//
// API version pinning (codex plan-pass WARNING): the SDK's published types
// only accept `Stripe.LatestApiVersion`. Hard-coding a specific literal like
// `'2024-12-18.acacia'` fails `tsc --noEmit` whenever the SDK bumps its
// version constant. Use the exported constant for forward compatibility.
import Stripe from 'stripe';
import { loadBillingConfig } from './plan-map';

let cached: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (cached) return cached;
  const config = loadBillingConfig();
  cached = new Stripe(config.STRIPE_SECRET_KEY, {
    apiVersion: Stripe.LatestApiVersion,
  });
  return cached;
}

export function _resetStripeClientForTests(): void {
  cached = null;
}
