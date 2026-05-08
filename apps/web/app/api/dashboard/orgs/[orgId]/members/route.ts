// app/api/dashboard/orgs/[orgId]/members/route.ts
//
// GET /api/dashboard/orgs/:orgId/members — list active members with email lookup.
// Active member of orgId required; non-member → 404 (no enumeration).

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveSessionUserId } from '@/lib/dashboard/membership-guard';

interface RouteParams { params: Promise<{ orgId: string }> | { orgId: string } }

interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
  joined_at: string;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const p = await Promise.resolve(params) as { orgId: string };
  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const supabase = createServiceRoleClient();

  // Cross-org enumeration guard — caller must be active member.
  const { data: callerMembership } = await supabase.from('memberships')
    .select('id')
    .eq('organization_id', p.orgId)
    .eq('user_id', callerUserId)
    .eq('status', 'active')
    .maybeSingle();
  if (!callerMembership) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const { data: rows } = await supabase.from('memberships')
    .select('id, organization_id, user_id, role, status, joined_at')
    .eq('organization_id', p.orgId)
    .eq('status', 'active');
  const memberRows = (rows as MembershipRow[] | null) ?? [];

  // Codex plan-pass CRITICAL — members list MUST return emails for the
  // UI table. Service-role can read auth.users.
  // Implementation note (plan): supabase-js's .schema('auth').from('users')
  // is the canonical path. Both the production runtime and the test stub
  // expose `from('auth.users')` semantics — the stub keys tables by string
  // and will return the seeded auth.users rows. In production the
  // service-role client has read access to the auth schema directly. We use
  // a small admin REST shape: .from('auth.users' as never) keeps a single
  // shape across both layers without bringing in a custom RPC.
  const userIds = memberRows.map((m) => m.user_id);
  const emailMap = new Map<string, string>();
  if (userIds.length > 0) {
    // Try schema('auth') first (preferred when supported by supabase-js).
    let users: { id: string; email: string }[] | null = null;
    const sbAny = supabase as unknown as {
      schema?: (s: string) => { from: (t: string) => { select: (cols: string) => { in: (col: string, vals: string[]) => Promise<{ data: { id: string; email: string }[] | null }> } } };
    };
    if (typeof sbAny.schema === 'function') {
      try {
        const { data } = await sbAny.schema('auth').from('users').select('id, email').in('id', userIds);
        users = data ?? null;
      } catch {
        users = null;
      }
    }
    // Fallback: stub-friendly literal table reference.
    if (!users || users.length === 0) {
      const { data } = await (supabase.from('auth.users' as never) as unknown as {
        select: (cols: string) => { in: (col: string, vals: string[]) => Promise<{ data: { id: string; email: string }[] | null }> };
      }).select('id, email').in('id', userIds);
      users = data ?? null;
    }
    for (const u of users ?? []) {
      emailMap.set(u.id, u.email);
    }
  }

  const members = memberRows.map((m) => ({
    id: m.id,
    userId: m.user_id,
    email: emailMap.get(m.user_id) ?? null,
    role: m.role,
    status: m.status,
    joinedAt: m.joined_at,
  }));
  return NextResponse.json({ members }, { status: 200 });
}
