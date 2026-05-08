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

// Stripe.LatestApiVersion is a TYPE, not a runtime value — passing it to
// `new Stripe(...)` requires a string literal that matches the SDK's
// declared LatestApiVersion. SDK bumps the literal in minor versions; we
// satisfy the typechecker by typing the literal as the type itself.
const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2025-02-24.acacia';

export function getStripeClient(): Stripe {
  if (cached) return cached;
  const config = loadBillingConfig();
  cached = new Stripe(config.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
  });
  return cached;
}

export function _resetStripeClientForTests(): void {
  cached = null;
}
