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

export const dynamic = 'force-dynamic';

interface SearchParams { orgId?: string }

interface SettingsRow {
  workos_organization_id: string | null;
  workos_connection_id: string | null;
  sso_connection_status: 'inactive' | 'pending' | 'active' | 'disabled' | null;
  sso_connected_at: string | null;
  sso_disabled_at: string | null;
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
    .select('workos_organization_id, workos_connection_id, sso_connection_status, sso_connected_at, sso_disabled_at')
    .eq('organization_id', orgId)
    .maybeSingle();
  const settings = (settingsRow as SettingsRow | null) ?? {
    workos_organization_id: null,
    workos_connection_id: null,
    sso_connection_status: null,
    sso_connected_at: null,
    sso_disabled_at: null,
  };

  return (
    <SsoSetupCard
      orgId={orgId}
      initialStatus={settings.sso_connection_status ?? 'inactive'}
      workosOrganizationId={settings.workos_organization_id}
      workosConnectionId={settings.workos_connection_id}
      connectedAt={settings.sso_connected_at}
      disabledAt={settings.sso_disabled_at}
    />
  );
}
