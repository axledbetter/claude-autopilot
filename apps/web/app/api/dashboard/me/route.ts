import { NextResponse } from 'next/server';
import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { authViaApiKey } from '@/lib/dashboard/auth';

interface MembershipRow {
  organization_id: string;
  role: string;
  status: string;
}

interface OrganizationRow {
  id: string;
  name: string;
}

interface RunRow {
  user_id: string;
  created_at: string;
  source_verified: boolean | null;
}

async function resolveSession(): Promise<{ userId: string; email: string | null } | null> {
  try {
    const cookieStore = await cookies();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return null;
    const ssr = createSsrServerClient(url, anon, {
      cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await ssr.auth.getUser();
    if (!user) return null;
    return { userId: user.id, email: user.email ?? null };
  } catch {
    return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  // Auth — accept API-key bearer OR Supabase session.
  let userId: string | null = null;
  let email: string | null = null;
  let fingerprint: string | null = null;

  const apiKeyAuth = await authViaApiKey(req);
  if (apiKeyAuth) {
    userId = apiKeyAuth.userId;
    // Pull email + fingerprint from service-role lookup.
    const supabase = createServiceRoleClient();
    const { data: keyRow } = await supabase.from('api_keys')
      .select('prefix_display')
      .eq('id', apiKeyAuth.keyId)
      .maybeSingle();
    fingerprint = (keyRow as { prefix_display: string } | null)?.prefix_display ?? null;
  } else {
    const session = await resolveSession();
    if (session) {
      userId = session.userId;
      email = session.email;
    }
  }

  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const supabase = createServiceRoleClient();

  // Resolve email if we got it via API key (no session).
  if (!email) {
    const { data: userRow } = await supabase.from('users')
      .select('email')
      .eq('id', userId)
      .maybeSingle();
    email = (userRow as { email: string } | null)?.email ?? null;
  }

  // Memberships → organizations.
  const { data: memberships } = await supabase.from('memberships')
    .select('organization_id, role, status')
    .eq('user_id', userId)
    .eq('status', 'active');
  const ms = (memberships as MembershipRow[] | null) ?? [];

  let organizations: Array<{ id: string; name: string; role: string }> = [];
  if (ms.length > 0) {
    const orgIds = ms.map((m) => m.organization_id);
    const { data: orgs } = await supabase.from('organizations')
      .select('id, name')
      .in('id', orgIds);
    const orgRows = (orgs as OrganizationRow[] | null) ?? [];
    organizations = ms
      .map((m) => {
        const org = orgRows.find((o) => o.id === m.organization_id);
        if (!org) return null;
        return { id: org.id, name: org.name, role: m.role };
      })
      .filter((x): x is { id: string; name: string; role: string } => x !== null);
  }

  // lastUploadAt — max created_at over runs where source_verified=true.
  const { data: runs } = await supabase.from('runs')
    .select('user_id, created_at, source_verified')
    .eq('user_id', userId);
  const runRows = (runs as RunRow[] | null) ?? [];
  const verified = runRows.filter((r) => r.source_verified === true);
  const lastUploadAt = verified.length > 0
    ? verified.reduce((max, r) => (r.created_at > max ? r.created_at : max), verified[0]!.created_at)
    : null;

  return NextResponse.json({
    email,
    fingerprint,
    organizations,
    lastUploadAt,
  }, { status: 200 });
}
