// Phase 3 — Stripe billing plan map + runtime env validation.
//
// Two config loaders by design (codex plan-pass WARNING):
//   loadPublicBillingConfig() — only AUTOPILOT_PUBLIC_BASE_URL. Used by
//     /api/upload-session entitlement gate; missing Stripe env must NOT
//     break upload-session.
//   loadBillingConfig() — full Stripe config. Reserved for Stripe-touching
//     routes (webhook, checkout, portal).
//
// Both use a `safeParse` + descriptive throw, matching the spec's runtime
// guarantee that env mistakes surface immediately and not as a silent
// `undefined` price ID later.
import { z } from 'zod';

const PublicConfigSchema = z.object({
  AUTOPILOT_PUBLIC_BASE_URL: z.string().url().default('https://autopilot.dev'),
});

const FullConfigSchema = PublicConfigSchema.extend({
  STRIPE_SECRET_KEY: z.string().min(20).startsWith('sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().min(20).startsWith('whsec_'),
  STRIPE_PRICE_SMALL_MONTHLY: z.string().min(20).startsWith('price_'),
  STRIPE_PRICE_SMALL_YEARLY: z.string().min(20).startsWith('price_'),
  STRIPE_PRICE_MID_MONTHLY: z.string().min(20).startsWith('price_'),
  STRIPE_PRICE_MID_YEARLY: z.string().min(20).startsWith('price_'),
});

export type PublicBillingConfig = z.infer<typeof PublicConfigSchema>;
export type BillingConfig = z.infer<typeof FullConfigSchema>;

let cachedPublic: PublicBillingConfig | null = null;
let cachedFull: BillingConfig | null = null;

export function loadPublicBillingConfig(): PublicBillingConfig {
  if (cachedPublic) return cachedPublic;
  const parsed = PublicConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid public billing config: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  cachedPublic = parsed.data;
  return cachedPublic;
}

export function loadBillingConfig(): BillingConfig {
  if (cachedFull) return cachedFull;
  const parsed = FullConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid billing config: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  cachedFull = parsed.data;
  cachedPublic = parsed.data; // full implies public
  return cachedFull;
}

export function _resetBillingConfigForTests(): void {
  cachedPublic = null;
  cachedFull = null;
}

export type Tier = 'small' | 'mid';
export type Interval = 'monthly' | 'yearly';

// Codex pass 2 — annual pricing built in. PLAN_MAP keys by (tier, interval)
// so all four price IDs map back to their tier.
export const PLAN_MAP = {
  small: {
    monthly: { get priceId(): string { return loadBillingConfig().STRIPE_PRICE_SMALL_MONTHLY; } },
    yearly:  { get priceId(): string { return loadBillingConfig().STRIPE_PRICE_SMALL_YEARLY; } },
    runsPerMonthCap: 1000,
    storageBytesCap: 50 * 1024 * 1024 * 1024,
  },
  mid: {
    monthly: { get priceId(): string { return loadBillingConfig().STRIPE_PRICE_MID_MONTHLY; } },
    yearly:  { get priceId(): string { return loadBillingConfig().STRIPE_PRICE_MID_YEARLY; } },
    runsPerMonthCap: 10000,
    storageBytesCap: 500 * 1024 * 1024 * 1024,
  },
} as const;

export function tierForPriceId(priceId: string): { tier: Tier; interval: Interval } | null {
  const cfg = loadBillingConfig();
  if (priceId === cfg.STRIPE_PRICE_SMALL_MONTHLY) return { tier: 'small', interval: 'monthly' };
  if (priceId === cfg.STRIPE_PRICE_SMALL_YEARLY)  return { tier: 'small', interval: 'yearly' };
  if (priceId === cfg.STRIPE_PRICE_MID_MONTHLY)   return { tier: 'mid', interval: 'monthly' };
  if (priceId === cfg.STRIPE_PRICE_MID_YEARLY)    return { tier: 'mid', interval: 'yearly' };
  return null;
}

export function capsForTier(tier: Tier): { runsPerMonthCap: number; storageBytesCap: number } {
  return {
    runsPerMonthCap: PLAN_MAP[tier].runsPerMonthCap,
    storageBytesCap: PLAN_MAP[tier].storageBytesCap,
  };
}
