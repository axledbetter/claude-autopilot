// /dashboard/admin/members — Phase 5.1.
//
// Server component. 404s if caller has no admin/owner membership for the
// `orgId` query param. Renders <MembersList> client component which talks
// to the API directly.

import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import MembersList, { type MemberRow } from '@/components/admin/MembersList';

export const dynamic = 'force-dynamic';

interface SearchParams { orgId?: string }

export default async function MembersPage(
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
  const callerRole = (callerRow as { role: string } | null)?.role;
  if (!callerRole || !['admin', 'owner'].includes(callerRole)) notFound();

  // Initial render via the SECURITY DEFINER RPC (codex PR-pass CRITICAL —
  // direct auth.users access not reliable in production).
  const { data: rpcData } = await svc.rpc('list_org_members_with_emails', {
    p_caller_user_id: user.id,
    p_org_id: orgId,
  });
  const initial: MemberRow[] = (rpcData as { members: MemberRow[] } | null)?.members ?? [];

  return (
    <MembersList
      orgId={orgId}
      callerUserId={user.id}
      callerRole={callerRole as 'admin' | 'owner'}
      initialMembers={initial}
    />
  );
}
