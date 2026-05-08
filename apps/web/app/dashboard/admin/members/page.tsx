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

  // Initial render — pull memberships + emails. Client refreshes from API on mutation.
  const { data: memberRowsRaw } = await svc.from('memberships')
    .select('id, user_id, role, status, joined_at')
    .eq('organization_id', orgId)
    .eq('status', 'active');
  const memberRows = (memberRowsRaw as { id: string; user_id: string; role: string; status: string; joined_at: string }[] | null) ?? [];
  const userIds = memberRows.map((m) => m.user_id);
  const emailMap = new Map<string, string>();
  if (userIds.length > 0) {
    const sbAny = svc as unknown as {
      schema?: (s: string) => { from: (t: string) => { select: (cols: string) => { in: (col: string, vals: string[]) => Promise<{ data: { id: string; email: string }[] | null }> } } };
    };
    let users: { id: string; email: string }[] | null = null;
    if (typeof sbAny.schema === 'function') {
      try {
        const res = await sbAny.schema('auth').from('users').select('id, email').in('id', userIds);
        users = res.data ?? null;
      } catch { users = null; }
    }
    if (!users || users.length === 0) {
      const res = await (svc.from('auth.users' as never) as unknown as {
        select: (cols: string) => { in: (col: string, vals: string[]) => Promise<{ data: { id: string; email: string }[] | null }> };
      }).select('id, email').in('id', userIds);
      users = res.data ?? null;
    }
    for (const u of users ?? []) emailMap.set(u.id, u.email);
  }
  const initial: MemberRow[] = memberRows.map((m) => ({
    id: m.id,
    userId: m.user_id,
    email: emailMap.get(m.user_id) ?? null,
    role: m.role as MemberRow['role'],
    status: m.status,
    joinedAt: m.joined_at,
  }));

  return (
    <MembersList
      orgId={orgId}
      callerUserId={user.id}
      callerRole={callerRole as 'admin' | 'owner'}
      initialMembers={initial}
    />
  );
}
