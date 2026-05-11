// POST /api/dashboard/orgs/:orgId/sso/setup — Phase 5.4.
//
// Admin-gated portal-link sequence. Codex PR-pass CRITICAL #1: explicit
// admin check BEFORE any WorkOS API call (defense-in-depth — RPC also
// re-checks).
//
// Sequence:
//   1. assertSameOrigin
//   2. resolveSessionUserId (cookie-verified getUser)
//   3. Verify caller is active admin/owner of orgId (route-level check;
//      RPC re-validates).
//   4. Read org name + existing workos_organization_id from settings.
//   5. If no workos_organization_id stored:
//      a. Try getOrganizationByExternalId(orgId) — recovers from a
//         previous successful WorkOS create whose RPC persist failed
//         (codex PR-pass CRITICAL #2). 404 → fall through to create.
//      b. Otherwise createOrganization({ externalId: orgId }).
//   6. record_sso_setup_initiated RPC (admin auth + reassignment guard +
//      audit append + status flip to pending). Persists the binding.
//   7. Generate Admin Portal link via SDK and return { portalUrl }.
//
// Cache-Control: private, no-store — portal links are short-lived secrets.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import { getWorkOS } from '@/lib/workos/client';
import {
  assertActiveMembershipForOrg,
  respondToMembershipError,
} from '@/lib/dashboard/assert-active-membership-for-org';

interface RouteParams { params: Promise<{ orgId: string }> | { orgId: string } }

export const runtime = 'nodejs';

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { orgId: string };
  if (!isValidUuid(p.orgId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422 });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // v7.5.0 CRITICAL #3 — defense-in-depth membership gate. Runs BEFORE
  // the existing route-level admin check so a disabled admin can't
  // even reach the WorkOS API.
  try {
    await assertActiveMembershipForOrg({ orgId: p.orgId, userId: callerUserId });
  } catch (err) {
    const r = respondToMembershipError(err);
    if (r) return r;
    throw err;
  }

  const supabase = createServiceRoleClient();

  // Step 3: route-level admin check. Codex PR-pass CRITICAL #1 — must
  // happen BEFORE any WorkOS API call so non-admins can't trigger
  // external side effects. The RPC re-validates as defense-in-depth.
  const { data: callerRow } = await supabase
    .from('memberships')
    .select('role')
    .eq('organization_id', p.orgId)
    .eq('user_id', callerUserId)
    .eq('status', 'active')
    .maybeSingle();
  const callerRole = (callerRow as { role: string } | null)?.role;
  if (!callerRole || !['admin', 'owner'].includes(callerRole)) {
    return NextResponse.json({ error: 'not_admin' }, { status: 403 });
  }

  // Step 4: read org + existing mapping.
  const { data: orgRow, error: orgErr } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('id', p.orgId)
    .maybeSingle();
  if (orgErr) {
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
  if (!orgRow) {
    return NextResponse.json({ error: 'org_not_found' }, { status: 404 });
  }

  const { data: settingsRow } = await supabase
    .from('organization_settings')
    .select('workos_organization_id')
    .eq('organization_id', p.orgId)
    .maybeSingle();
  let workosOrgId: string | null =
    (settingsRow as { workos_organization_id: string | null } | null)?.workos_organization_id ?? null;

  // Step 5: resolve WorkOS org. Codex PR-pass CRITICAL #2 — try
  // getOrganizationByExternalId first to recover from a previous
  // successful WorkOS create whose subsequent RPC persist failed
  // (otherwise we'd orphan the WorkOS org on every retry).
  if (!workosOrgId) {
    const workos = getWorkOS();
    try {
      const found = (await workos.organizations.getOrganizationByExternalId(p.orgId)) as { id: string } | null;
      if (found?.id) workosOrgId = found.id;
    } catch (err) {
      // Treat any lookup error (typically 404) as "not found" and fall
      // through to create. SDK throws NotFoundException for 404.
      const name = err instanceof Error ? err.constructor.name : '';
      if (name !== 'NotFoundException' && !(err instanceof Error && err.message.toLowerCase().includes('not found'))) {
        return NextResponse.json({ error: 'workos_lookup_failed', detail: err instanceof Error ? err.message : 'unknown' }, { status: 502 });
      }
    }
    if (!workosOrgId) {
      try {
        const created = (await workos.organizations.createOrganization({
          name: (orgRow as { name: string }).name,
          externalId: p.orgId,
        })) as { id: string };
        workosOrgId = created.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'workos_create_failed';
        return NextResponse.json({ error: 'workos_create_failed', detail: msg }, { status: 502 });
      }
    }
  }

  // Step 5: admin authz + reassignment guard + audit happen inside RPC.
  const { error: rpcErr } = await supabase.rpc('record_sso_setup_initiated', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
    p_workos_organization_id: workosOrgId,
  });
  if (rpcErr) {
    const mapped = mapPostgresError(rpcErr);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  // Step 6: generate Admin Portal link. SDK exposes this as `adminPortal`,
  // not `portal`. Intent literal must match GenerateLinkIntent enum.
  let portalUrl: string;
  try {
    const workos = getWorkOS();
    const portal = (await workos.adminPortal.generateLink({
      organization: workosOrgId,
      intent: 'sso' as never,
    })) as { link: string };
    portalUrl = portal.link;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'portal_link_failed';
    return NextResponse.json({ error: 'portal_link_failed', detail: msg }, { status: 502 });
  }

  return NextResponse.json(
    { portalUrl, workosOrganizationId: workosOrgId },
    { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
