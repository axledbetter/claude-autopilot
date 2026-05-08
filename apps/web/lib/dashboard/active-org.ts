// Phase 5.3 — active org resolution.
//
// Reads `cao_active_org` cookie. Validates against memberships. Falls back
// to first active membership when cookie missing/stale. Returns null if
// caller has no active memberships at all.

import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

export const ACTIVE_ORG_COOKIE = 'cao_active_org';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActiveOrgContext {
  orgId: string;
  fromCookie: boolean;  // true if cookie hit; false if fallback to first
}

export async function resolveActiveOrg(
  supabase: SupabaseClient,
  userId: string,
): Promise<ActiveOrgContext | null> {
  // Best-effort cookie read. If we're outside a request scope (older test
  // harnesses, ad-hoc invocation), treat it as no cookie and fall through
  // to first-membership.
  let cookieValue: string | null = null;
  try {
    const cookieStore = await cookies();
    cookieValue = cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null;
  } catch {
    cookieValue = null;
  }

  // Pull all active memberships once; we'll either match the cookie or fall
  // back to the first.
  const { data } = await supabase.from('memberships')
    .select('organization_id')
    .eq('user_id', userId)
    .eq('status', 'active');
  const memberships = (data as { organization_id: string }[] | null) ?? [];
  if (memberships.length === 0) return null;

  if (cookieValue && UUID_RE.test(cookieValue)) {
    const hit = memberships.find((m) => m.organization_id === cookieValue);
    if (hit) return { orgId: hit.organization_id, fromCookie: true };
    // Stale cookie — fall through.
  }
  return { orgId: memberships[0]!.organization_id, fromCookie: false };
}

export async function listActiveOrgs(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ id: string; name: string; role: string }[]> {
  const { data } = await supabase.from('memberships')
    .select('organization_id, role')
    .eq('user_id', userId)
    .eq('status', 'active');
  const memberships = (data as { organization_id: string; role: string }[] | null) ?? [];
  if (memberships.length === 0) return [];

  const orgIds = memberships.map((m) => m.organization_id);
  const { data: orgs } = await supabase.from('organizations')
    .select('id, name')
    .in('id', orgIds);
  const orgRows = (orgs as { id: string; name: string }[] | null) ?? [];
  const nameById = new Map(orgRows.map((o) => [o.id, o.name]));

  return memberships.map((m) => ({
    id: m.organization_id,
    name: nameById.get(m.organization_id) ?? m.organization_id.slice(0, 8),
    role: m.role,
  }));
}
