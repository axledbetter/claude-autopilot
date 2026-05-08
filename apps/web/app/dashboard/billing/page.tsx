// /dashboard/billing — Phase 4 server component.
//
// Shows: current plan, caps, usage. Upgrade/Manage subscription buttons.

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import PlanCard from '@/components/dashboard/PlanCard';
import ManageSubscriptionButton from './_components/ManageSubscriptionButton';

export const dynamic = 'force-dynamic';

interface MembershipRow { organization_id: string; role: string; status: string }
interface EntitlementRow { plan: string; runs_per_month_cap: number | null; storage_bytes_cap: number | null; stripe_subscription_status: string | null }

export default async function BillingPage(): Promise<React.ReactElement> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <div>Not signed in</div>;

  const svc = createServiceRoleClient();

  const { data: membershipsRaw } = await svc.from('memberships')
    .select('organization_id, role, status')
    .eq('user_id', user.id)
    .eq('status', 'active');
  const memberships = (membershipsRaw as MembershipRow[] | null) ?? [];
  const organizationId = memberships[0]?.organization_id ?? null;

  // Entitlement.
  let entitlement: EntitlementRow = {
    plan: 'free',
    runs_per_month_cap: 100,
    storage_bytes_cap: 5 * 1024 * 1024 * 1024,
    stripe_subscription_status: null,
  };
  if (organizationId) {
    const { data } = await svc.from('entitlements')
      .select('plan, runs_per_month_cap, storage_bytes_cap, stripe_subscription_status')
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (data) entitlement = data as EntitlementRow;
  } else {
    const { data } = await svc.from('personal_entitlements')
      .select('plan, runs_per_month_cap, storage_bytes_cap, stripe_subscription_status')
      .eq('user_id', user.id)
      .maybeSingle();
    if (data) entitlement = data as EntitlementRow;
  }

  // Usage via the Phase 3 RPCs.
  let runsUsed = 0;
  let storageUsed = 0;
  try {
    const { data: runsCount } = await svc.rpc('count_runs_this_month', {
      p_user_id: user.id, p_organization_id: organizationId,
    });
    runsUsed = (runsCount as number) ?? 0;
    const { data: bytes } = await svc.rpc('sum_retained_bytes', {
      p_user_id: user.id, p_organization_id: organizationId, p_retention_days: 90,
    });
    storageUsed = (bytes as number) ?? 0;
  } catch {
    // Phase 3 RPCs may not exist in dev/stub — best-effort.
  }

  const hasPaidSub = entitlement.plan !== 'free' && entitlement.stripe_subscription_status != null;

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <h1 className="text-2xl font-bold">Billing</h1>

      <PlanCard
        plan={entitlement.plan}
        organizationId={organizationId}
        runsUsed={runsUsed}
        runsCap={entitlement.runs_per_month_cap ?? 100}
        storageUsedBytes={storageUsed}
        storageCapBytes={entitlement.storage_bytes_cap ?? 5 * 1024 * 1024 * 1024}
      />

      {hasPaidSub && organizationId && (
        <ManageSubscriptionButton organizationId={organizationId} />
      )}

      <div className="text-xs opacity-60 leading-relaxed">
        Cost / duration / status numbers in the dashboard are{' '}
        <strong>reported by the CLI</strong>. Final billing is calculated by
        Stripe based on your subscription tier — the displayed cost is a
        best-effort estimate, not an invoice line item.
      </div>
    </div>
  );
}
