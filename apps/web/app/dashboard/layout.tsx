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
import { resolveActiveOrg, listActiveOrgs } from '@/lib/dashboard/active-org';
import OrgSwitcher from '@/components/dashboard/OrgSwitcher';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }): Promise<React.ReactElement> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect(('/?next=' + encodeURIComponent('/dashboard')) as Route);
  }

  const email = user.email ?? '';
  const svc = createServiceRoleClient();

  // Phase 5.3 — resolve active org via cookie + show switcher when multi-org.
  let activeOrgId: string | null = null;
  let orgs: { id: string; name: string; role: string }[] = [];
  try {
    const ctx = await resolveActiveOrg(svc, user.id);
    activeOrgId = ctx?.orgId ?? null;
    orgs = await listActiveOrgs(svc, user.id);
  } catch {
    activeOrgId = null;
    orgs = [];
  }

  // Admin link visible when caller is admin/owner in active org.
  let adminLinkOrgId: string | null = null;
  if (activeOrgId) {
    const activeOrg = orgs.find((o) => o.id === activeOrgId);
    if (activeOrg && ['admin', 'owner'].includes(activeOrg.role)) {
      adminLinkOrgId = activeOrgId;
    }
  }
  const adminHref = adminLinkOrgId
    ? (`/dashboard/admin/members?orgId=${adminLinkOrgId}` as Route)
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
        {orgs.length > 1 && activeOrgId && (
          <div className="mt-3 pt-3 border-t border-white/10 px-3">
            <div className="text-xs opacity-50 mb-1">Active org</div>
            <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} />
          </div>
        )}
        <div className="mt-auto pt-4 border-t border-white/10 text-xs opacity-60 px-3">
          {email}
        </div>
      </aside>
      <main className="p-8">{children}</main>
    </div>
  );
}
