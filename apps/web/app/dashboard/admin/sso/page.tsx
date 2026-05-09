// /dashboard/admin/sso — Phase 5.4.
//
// Owner-only. 404s for everyone else (codex pass 2 WARNING settled —
// Phase 5.1 settings page pattern).
//
// Reads organization_settings.sso_connection_status and renders
// <SsoSetupCard> with current state + button to launch portal.

import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import SsoSetupCard from '@/components/admin/SsoSetupCard';
import SsoDomainsCard, { type DomainClaim } from '@/components/admin/SsoDomainsCard';
import SsoRequiredToggle from '@/components/admin/SsoRequiredToggle';

export const dynamic = 'force-dynamic';

interface SearchParams { orgId?: string }

type Status = 'inactive' | 'pending' | 'active' | 'disabled';

interface SettingsRow {
  workos_organization_id: string | null;
  workos_connection_id: string | null;
  sso_connection_status: Status | null;
  sso_connected_at: string | null;
  sso_disabled_at: string | null;
  sso_required: boolean | null;
}

interface ClaimRow {
  id: string;
  domain: string;
  status: 'pending' | 'verified' | 'revoked';
  challenge_token: string;
}

export default async function SsoSetupPage(
  { searchParams }: { searchParams: Promise<SearchParams> },
): Promise<React.ReactElement> {
  const { orgId } = await searchParams;
  if (!orgId) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const svc = createServiceRoleClient();
  const { data: callerRow } = await svc.from('memberships')
    .select('role')
    .eq('organization_id', orgId)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();
  if ((callerRow as { role: string } | null)?.role !== 'owner') notFound();

  const { data: settingsRow } = await svc.from('organization_settings')
    .select('workos_organization_id, workos_connection_id, sso_connection_status, sso_connected_at, sso_disabled_at, sso_required')
    .eq('organization_id', orgId)
    .maybeSingle();
  const settings = (settingsRow as SettingsRow | null) ?? {
    workos_organization_id: null,
    workos_connection_id: null,
    sso_connection_status: null,
    sso_connected_at: null,
    sso_disabled_at: null,
    sso_required: null,
  };
  const status: Status = settings.sso_connection_status ?? 'inactive';

  const { data: claimRows } = await svc.from('organization_domain_claims')
    .select('id, domain, status, challenge_token')
    .eq('organization_id', orgId)
    .neq('status', 'revoked')
    .order('created_at', { ascending: true });
  const initialClaims: DomainClaim[] = ((claimRows as ClaimRow[] | null) ?? []).map((c) => ({
    id: c.id,
    domain: c.domain,
    status: c.status,
    challengeRecordName: c.status === 'pending' ? `_workos-verify.${c.domain}` : undefined,
    challengeRecordValue: c.status === 'pending' ? c.challenge_token : undefined,
  }));

  return (
    <div className="flex flex-col gap-6">
      <SsoSetupCard
        orgId={orgId}
        initialStatus={status}
        workosOrganizationId={settings.workos_organization_id}
        workosConnectionId={settings.workos_connection_id}
        connectedAt={settings.sso_connected_at}
        disabledAt={settings.sso_disabled_at}
      />
      <SsoDomainsCard orgId={orgId} initialClaims={initialClaims} />
      <SsoRequiredToggle
        orgId={orgId}
        initialSsoRequired={settings.sso_required ?? false}
        ssoConnectionStatus={status}
      />
    </div>
  );
}
