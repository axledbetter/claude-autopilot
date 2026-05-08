// Phase 3 — entitlement gate at /api/upload-session mint time.
//
// Branches by ownership shape:
//   organizationId != null → entitlements row keyed by organization_id
//                            (free, small, mid, enterprise all stored here).
//   organizationId == null → personal_entitlements keyed by user_id
//                            (self-heal: upsert default if missing).
//
// Subscription state grace logic (per spec):
//   1. canceled AND past current_period_end → fall back to free caps.
//   2. cancel_at <= now → fall back to free caps (cancel-at-period-end honored).
//   3. payment_failed_at older than 7 days → fall back to free caps.
//   Otherwise honor the row's caps.
//
// Run-count cap uses STRICT '>' comparison (codex plan-pass CRITICAL #3):
// the runs row already exists when /api/upload-session is called, so
// count_runs_this_month INCLUDES the current run. "100 free runs" means:
// count=100 is the 100th and is allowed; reject only at count >= 101.
import { createServiceRoleClient } from '@/lib/supabase/service';
import { loadPublicBillingConfig } from './plan-map';

export type EffectivePlan = 'free' | 'small' | 'mid' | 'enterprise';

export interface EntitlementResult {
  exceeded: boolean;
  kind: 'runs_per_month' | 'storage_bytes' | 'none';
  current: number;
  max: number;
  upgradeUrl: string;
  effectivePlan: EffectivePlan;
}

export interface EntitlementInput {
  organizationId: string | null;
  userId: string;
  /** CLI-provided estimate from fs.stat(events.ndjson).size. May be 0. */
  expectedBytes: number;
}

const FREE_RUNS_CAP = 100;
const FREE_STORAGE_CAP = 5 * 1024 * 1024 * 1024;
const PAYMENT_FAILED_GRACE_DAYS = 7;
const RETENTION_DAYS = 90;

interface EntitlementRow {
  plan: EffectivePlan;
  runs_per_month_cap: number | null;
  storage_bytes_cap: number | null;
  stripe_subscription_status: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  payment_failed_at: string | null;
}

interface PersonalEntitlementRow {
  runs_per_month_cap: number;
  storage_bytes_cap: number;
}

export async function checkEntitlement(input: EntitlementInput): Promise<EntitlementResult> {
  const config = loadPublicBillingConfig();
  const upgradeUrl = `${config.AUTOPILOT_PUBLIC_BASE_URL}/dashboard/billing`;
  const supabase = createServiceRoleClient();

  let runsCap: number | null = null;
  let storageCap: number | null = null;
  let effectivePlan: EffectivePlan;

  if (input.organizationId) {
    const { data: ent } = await supabase.from('entitlements')
      .select('plan, runs_per_month_cap, storage_bytes_cap, stripe_subscription_status, current_period_end, cancel_at, payment_failed_at')
      .eq('organization_id', input.organizationId)
      .maybeSingle();
    if (!ent) {
      throw new Error(
        `entitlements row missing for org ${input.organizationId} — should have been seeded by trigger`,
      );
    }
    const e = ent as EntitlementRow;

    const now = new Date();
    const periodEnd = e.current_period_end ? new Date(e.current_period_end) : null;
    const cancelAt = e.cancel_at ? new Date(e.cancel_at) : null;
    const paymentFailed = e.payment_failed_at ? new Date(e.payment_failed_at) : null;

    let fellBackToFree = false;
    if (e.plan !== 'free' && e.plan !== 'enterprise') {
      if (e.stripe_subscription_status === 'canceled' && periodEnd && periodEnd < now) {
        fellBackToFree = true;
      } else if (cancelAt && cancelAt < now) {
        fellBackToFree = true;
      } else if (
        paymentFailed
        && now.getTime() - paymentFailed.getTime() > PAYMENT_FAILED_GRACE_DAYS * 86400_000
      ) {
        fellBackToFree = true;
      }
    }
    effectivePlan = fellBackToFree ? 'free' : e.plan;

    if (effectivePlan === 'enterprise') {
      runsCap = null;
      storageCap = null;
    } else if (fellBackToFree) {
      runsCap = FREE_RUNS_CAP;
      storageCap = FREE_STORAGE_CAP;
    } else {
      runsCap = e.runs_per_month_cap;
      storageCap = e.storage_bytes_cap;
    }
  } else {
    // Personal tier — self-heal missing row (codex plan-pass WARNING).
    const { data: row } = await supabase.from('personal_entitlements')
      .select('runs_per_month_cap, storage_bytes_cap')
      .eq('user_id', input.userId)
      .maybeSingle();
    if (row) {
      const r = row as PersonalEntitlementRow;
      runsCap = r.runs_per_month_cap;
      storageCap = r.storage_bytes_cap;
    } else {
      await supabase.from('personal_entitlements').insert({
        user_id: input.userId,
        runs_per_month_cap: FREE_RUNS_CAP,
        storage_bytes_cap: FREE_STORAGE_CAP,
      });
      runsCap = FREE_RUNS_CAP;
      storageCap = FREE_STORAGE_CAP;
    }
    effectivePlan = 'free';
  }

  // Enterprise = no enforcement.
  if (runsCap === null || storageCap === null) {
    return {
      exceeded: false,
      kind: 'none',
      current: 0,
      max: 0,
      upgradeUrl,
      effectivePlan,
    };
  }

  // Run-count cap.
  const { data: runsCount } = await supabase.rpc('count_runs_this_month', {
    p_organization_id: input.organizationId,
    p_user_id: input.userId,
  });
  const runs = (runsCount as number | null) ?? 0;
  if (runs > runsCap) {
    return {
      exceeded: true,
      kind: 'runs_per_month',
      current: runs,
      max: runsCap,
      upgradeUrl,
      effectivePlan,
    };
  }

  // Storage cap with expectedBytes preflight (codex pass 2 CRITICAL #2).
  const { data: usedBytes } = await supabase.rpc('sum_retained_bytes', {
    p_organization_id: input.organizationId,
    p_user_id: input.userId,
    p_retention_days: RETENTION_DAYS,
  });
  const used = (usedBytes as number | null) ?? 0;
  const projected = used + Math.max(0, input.expectedBytes);
  if (projected > storageCap) {
    return {
      exceeded: true,
      kind: 'storage_bytes',
      current: projected,
      max: storageCap,
      upgradeUrl,
      effectivePlan,
    };
  }

  return {
    exceeded: false,
    kind: 'none',
    current: runs,
    max: runsCap,
    upgradeUrl,
    effectivePlan,
  };
}
