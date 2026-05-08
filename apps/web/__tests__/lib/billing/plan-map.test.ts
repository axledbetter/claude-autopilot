import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetBillingConfigForTests,
  loadBillingConfig,
  tierForPriceId,
} from '@/lib/billing/plan-map';

beforeEach(() => {
  _resetBillingConfigForTests();
  process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'x'.repeat(20);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + 'x'.repeat(20);
  process.env.STRIPE_PRICE_SMALL_MONTHLY = 'price_small_monthly_xxxxxxxxxxxx';
  process.env.STRIPE_PRICE_SMALL_YEARLY = 'price_small_yearly_xxxxxxxxxxxxx';
  process.env.STRIPE_PRICE_MID_MONTHLY = 'price_mid_monthly_xxxxxxxxxxxxxx';
  process.env.STRIPE_PRICE_MID_YEARLY = 'price_mid_yearly_xxxxxxxxxxxxxxx';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

describe('plan-map', () => {
  it('throws on missing env var', () => {
    delete process.env.STRIPE_PRICE_MID_YEARLY;
    _resetBillingConfigForTests();
    expect(() => loadBillingConfig()).toThrow(/Invalid billing config/);
  });

  it('round-trips priceId → (tier, interval) for all 4 prices', () => {
    expect(tierForPriceId(process.env.STRIPE_PRICE_SMALL_MONTHLY!)).toEqual({
      tier: 'small', interval: 'monthly',
    });
    expect(tierForPriceId(process.env.STRIPE_PRICE_SMALL_YEARLY!)).toEqual({
      tier: 'small', interval: 'yearly',
    });
    expect(tierForPriceId(process.env.STRIPE_PRICE_MID_MONTHLY!)).toEqual({
      tier: 'mid', interval: 'monthly',
    });
    expect(tierForPriceId(process.env.STRIPE_PRICE_MID_YEARLY!)).toEqual({
      tier: 'mid', interval: 'yearly',
    });
    expect(tierForPriceId('price_unknown_xxxxxxxxxxxxxxxxxxxxx')).toBeNull();
  });
});
