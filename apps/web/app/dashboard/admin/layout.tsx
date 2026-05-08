// /dashboard/admin layout — Phase 5.1.
//
// Gates the admin section: 404 if signed-out OR if caller has no
// admin/owner membership in any org.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

interface MembershipRow { organization_id: string; role: string }

export default async function AdminLayout({ children }: { children: React.ReactNode }): Promise<React.ReactElement> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const svc = createServiceRoleClient();
  const { data: rowsRaw } = await svc.from('memberships')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .in('role', ['admin', 'owner']);
  const rows = (rowsRaw as MembershipRow[] | null) ?? [];
  if (rows.length === 0) notFound();

  // Use the first admin/owner membership as the active org context. Phase 5.x
  // may add an explicit org switcher.
  const orgId = rows[0]!.organization_id;
  const membersHref = `/dashboard/admin/members?orgId=${orgId}` as Route;
  const settingsHref = `/dashboard/admin/settings?orgId=${orgId}` as Route;

  return (
    <div className="grid grid-cols-[200px_1fr] gap-8">
      <nav className="border-r border-white/10 pr-4 flex flex-col gap-1 text-sm">
        <Link href={membersHref} className="px-2 py-1 rounded hover:bg-white/5">
          Members
        </Link>
        <Link href={settingsHref} className="px-2 py-1 rounded hover:bg-white/5">
          Settings
        </Link>
      </nav>
      {children}
    </div>
  );
}
