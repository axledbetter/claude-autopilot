// /dashboard/admin/settings — Phase 5.1.
//
// Owner-only. 404s for everyone else (codex pass 2 WARNING settled).
// Renders <OrgSettingsForm> for editing org name.

import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import OrgSettingsForm from '@/components/admin/OrgSettingsForm';

export const dynamic = 'force-dynamic';

interface SearchParams { orgId?: string }

export default async function OrgSettingsPage(
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

  const { data: orgRow } = await svc.from('organizations')
    .select('id, name')
    .eq('id', orgId)
    .maybeSingle();
  const org = orgRow as { id: string; name: string } | null;
  if (!org) notFound();

  return <OrgSettingsForm orgId={orgId} initialName={org.name} />;
}
