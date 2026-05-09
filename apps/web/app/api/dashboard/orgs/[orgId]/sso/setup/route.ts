// POST /api/dashboard/orgs/:orgId/sso/setup — Phase 5.4.
//
// 6-step admin-gated portal-link sequence:
//   1. assertSameOrigin
//   2. resolveSessionUserId (cookie-verified getUser)
//   3. Read org name + existing workos_organization_id from settings.
//   4. If no workos_organization_id stored, server-create the WorkOS org
//      via SDK (idempotent on retry — externalId=orgId returns the
//      existing org if it was already created).
//   5. record_sso_setup_initiated RPC (admin auth + reassignment guard +
//      audit append + status flip to pending).
//   6. Generate Admin Portal link via SDK and return { portalUrl }.
//
// On idempotent retry: re-mapping the same WorkOS org succeeds and
// re-emits the portal link. If a DIFFERENT WorkOS org is already mapped
// and active, RPC raises workos_org_already_bound (422).
//
// Cache-Control: private, no-store — portal links are short-lived secrets.

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import { getWorkOS } from '@/lib/workos/client';

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

  const supabase = createServiceRoleClient();

  // Step 3: read org + existing mapping. (Admin authz lives in RPC; the
  // route reads with service role only to source org name + idempotent
  // WorkOS-org-id lookup. RPC will reject non-admin callers.)
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

  // Step 4: create WorkOS org if not yet mapped.
  if (!workosOrgId) {
    try {
      const workos = getWorkOS();
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

  // Step 6: generate Admin Portal link.
  let portalUrl: string;
  try {
    const workos = getWorkOS();
    const portal = (await workos.portal.generateLink({
      organization: workosOrgId,
      intent: 'sso',
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
