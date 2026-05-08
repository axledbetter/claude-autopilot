// Dashboard layout — Phase 4. Auth-gated shell with sidebar.
//
// Server Component. Uses createSupabaseServerClient for the auth check;
// unauthenticated users redirect to /?next=/dashboard. The middleware
// covers CSP/security headers for /dashboard routes (default policy);
// only /cli-auth gets the hardened policy.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Route } from 'next';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }): Promise<React.ReactElement> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect(('/?next=' + encodeURIComponent('/dashboard')) as Route);
  }

  const email = user.email ?? '';

  // Phase 5.1 — show "Admin" link only when caller has admin/owner
  // membership in any active org. Best-effort: render without the link
  // if the lookup fails, never block the dashboard for this.
  let firstAdminOrgId: string | null = null;
  try {
    const svc = createServiceRoleClient();
    const { data: rows } = await svc.from('memberships')
      .select('organization_id')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .in('role', ['admin', 'owner'])
      .limit(1);
    firstAdminOrgId = ((rows as { organization_id: string }[] | null) ?? [])[0]?.organization_id ?? null;
  } catch {
    firstAdminOrgId = null;
  }
  const adminHref = firstAdminOrgId
    ? (`/dashboard/admin/members?orgId=${firstAdminOrgId}` as Route)
    : null;

  return (
    <div className="grid grid-cols-[240px_1fr] min-h-screen">
      <aside className="border-r border-white/10 bg-black/20 p-4 flex flex-col gap-1">
        <div className="text-sm font-semibold opacity-70 mb-4 px-3">claude-autopilot</div>
        <Link href="/dashboard" className="px-3 py-2 rounded hover:bg-white/5 text-sm">
          Overview
        </Link>
        <Link href="/dashboard/runs" className="px-3 py-2 rounded hover:bg-white/5 text-sm">
          Runs
        </Link>
        <Link href="/dashboard/billing" className="px-3 py-2 rounded hover:bg-white/5 text-sm">
          Billing
        </Link>
        {adminHref && (
          <Link href={adminHref} className="px-3 py-2 rounded hover:bg-white/5 text-sm">
            Admin
          </Link>
        )}
        <div className="mt-auto pt-4 border-t border-white/10 text-xs opacity-60 px-3">
          {email}
        </div>
      </aside>
      <main className="p-8">{children}</main>
    </div>
  );
}
