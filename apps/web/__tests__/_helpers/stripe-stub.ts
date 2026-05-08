// In-memory Stripe SDK stub for webhook + checkout + portal route tests.
//
// Wired in via top-level `vi.mock('stripe', ...)` in test files. Provides
// just-enough surface for the routes:
//   - constructEvent(rawBody, sig, secret) — accepts 'valid-test-signature'
//     and returns JSON.parse(rawBody) as the event.
//   - checkout.sessions.create — returns { id, url, customer? } echoing
//     inputs so the route can persist the customer ID.
//   - billingPortal.sessions.create — returns { id, url }.
//   - subscriptions.retrieve — reads from state.subscriptions.

export interface StripeStubState {
  events: Map<string, unknown>;
  subscriptions: Map<string, unknown>;
  customers: Map<string, unknown>;
  checkoutSessions: Map<string, unknown>;
  portalSessions: Map<string, { url: string }>;
  /** captured idempotency keys from checkout.sessions.create calls. */
  checkoutIdempotencyKeys: string[];
  /** Force constructEvent to throw on the next call. */
  forceSignatureFailure: boolean;
}

export function makeStripeStubState(): StripeStubState {
  return {
    events: new Map(),
    subscriptions: new Map(),
    customers: new Map(),
    checkoutSessions: new Map(),
    portalSessions: new Map(),
    checkoutIdempotencyKeys: [],
    forceSignatureFailure: false,
  };
}

export const stripeStubState = makeStripeStubState();

export function resetStripeStubState(): void {
  stripeStubState.events.clear();
  stripeStubState.subscriptions.clear();
  stripeStubState.customers.clear();
  stripeStubState.checkoutSessions.clear();
  stripeStubState.portalSessions.clear();
  stripeStubState.checkoutIdempotencyKeys.length = 0;
  stripeStubState.forceSignatureFailure = false;
}

interface CheckoutSessionInput {
  customer?: string;
  customer_email?: string;
  mode?: string;
  success_url?: string;
  cancel_url?: string;
  client_reference_id?: string;
  line_items?: Array<{ price: string; quantity?: number }>;
  subscription_data?: { metadata?: Record<string, string> };
  metadata?: Record<string, string>;
}

interface PortalSessionInput {
  customer: string;
  return_url?: string;
}

interface BuiltClient {
  webhooks: {
    constructEvent: (rawBody: string, sig: string, secret: string) => unknown;
  };
  checkout: {
    sessions: {
      create: (
        input: CheckoutSessionInput,
        opts?: { idempotencyKey?: string },
      ) => Promise<{ id: string; url: string; customer: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create: (input: PortalSessionInput) => Promise<{ id: string; url: string }>;
    };
  };
  subscriptions: {
    retrieve: (id: string, opts?: { expand?: string[] }) => Promise<unknown>;
  };
  customers: {
    create: (input: { email?: string; metadata?: Record<string, string> }) => Promise<{ id: string }>;
  };
}

let customerCounter = 0;

export function buildStripeClient(state: StripeStubState = stripeStubState): BuiltClient {
  return {
    webhooks: {
      constructEvent(rawBody: string, sig: string, _secret: string): unknown {
        if (state.forceSignatureFailure || sig !== 'valid-test-signature') {
          throw new Error('signature verification failed');
        }
        const event = JSON.parse(rawBody);
        return event;
      },
    },
    checkout: {
      sessions: {
        async create(input, opts) {
          if (opts?.idempotencyKey) {
            state.checkoutIdempotencyKeys.push(opts.idempotencyKey);
          }
          let customerId = input.customer ?? null;
          if (!customerId && input.customer_email) {
            customerCounter++;
            customerId = `cus_test_${customerCounter}`;
            state.customers.set(customerId, { id: customerId, email: input.customer_email });
          }
          const id = `cs_test_${Math.random().toString(36).slice(2, 12)}`;
          const url = `https://checkout.stripe.com/c/pay/${id}`;
          state.checkoutSessions.set(id, { ...input, id, url, customer: customerId });
          return { id, url, customer: customerId };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(input) {
          const id = `bps_test_${Math.random().toString(36).slice(2, 12)}`;
          const url = `https://billing.stripe.com/p/session/${id}`;
          state.portalSessions.set(id, { url });
          if (!state.customers.has(input.customer)) {
            // Reflect a useful error for orgs whose customer doesn't exist.
            throw new Error(`No such customer: '${input.customer}'`);
          }
          return { id, url };
        },
      },
    },
    subscriptions: {
      async retrieve(id) {
        const sub = state.subscriptions.get(id);
        if (!sub) throw new Error(`No such subscription: '${id}'`);
        return sub;
      },
    },
    customers: {
      async create(input) {
        customerCounter++;
        const id = `cus_test_${customerCounter}`;
        state.customers.set(id, { id, ...input });
        return { id };
      },
    },
  };
}

/**
 * Helper for tests: build a `vi.mock('stripe', ...)` factory that returns a
 * Stripe constructor whose instance is the stub client. Mirrors the SDK's
 * default-export shape and exposes `LatestApiVersion` as a static.
 *
 * Usage at top of test file:
 *   vi.mock('stripe', () => stripeMockFactory());
 */
export function stripeMockFactory(): { default: unknown } {
  function MockStripe(this: BuiltClient, _key: string, _opts?: unknown): BuiltClient {
    const client = buildStripeClient();
    Object.assign(this, client);
    return this;
  }
  // Static property — used by stripe.ts wrapper.
  (MockStripe as unknown as { LatestApiVersion: string }).LatestApiVersion = '2025-02-24.acacia';
  return { default: MockStripe };
}
