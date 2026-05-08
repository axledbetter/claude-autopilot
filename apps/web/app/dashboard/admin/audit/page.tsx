// /dashboard/admin/audit — Phase 5.2.
// Server Component. Calls list_audit_events RPC for initial state, hands to client.

import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import AuditTable, { type AuditEventRow } from '@/components/admin/AuditTable';

export const dynamic = 'force-dynamic';

interface SearchParams { orgId?: string }

export default async function AuditPage(
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

  const { data } = await svc.rpc('list_audit_events', {
    p_caller_user_id: user.id,
    p_org_id: orgId,
    p_cursor_occurred_at: null,
    p_cursor_id: null,
    p_limit: 50,
    p_action: null,
    p_actor_user_id: null,
    p_since: null,
    p_until: null,
  });
  const initial = (data as { events: AuditEventRow[]; nextCursor: { occurredAt: string; id: number } | null } | null) ?? { events: [], nextCursor: null };

  return (
    <AuditTable
      orgId={orgId}
      initialEvents={initial.events}
      initialNextCursor={initial.nextCursor ? Buffer.from(JSON.stringify(initial.nextCursor), 'utf8').toString('base64') : null}
    />
  );
}
