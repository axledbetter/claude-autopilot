// POST /api/dashboard/orgs/:orgId/sso/domains — Phase 5.6.
//
// Admin-gated domain claim creation. Route normalizes the input domain
// before passing to the RPC (codex spec pass-2 WARNING #5 — single
// canonical normalize helper).
//
// Codex invariant: p_caller_user_id ONLY derived from
// resolveSessionUserId(), never from req body.

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { mapPostgresError, resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import { normalizeDomain } from '@/lib/dns/normalize-domain';
import {
  assertActiveMembershipForOrg,
  respondToMembershipError,
} from '@/lib/dashboard/assert-active-membership-for-org';

interface RouteParams { params: Promise<{ orgId: string }> | { orgId: string } }
interface Body { domain?: unknown }

export const runtime = 'nodejs';

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { orgId: string };
  if (!isValidUuid(p.orgId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422 });
  }

  let body: Body;
  try { body = (await req.json()) as Body; } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 422 });
  }
  if (typeof body.domain !== 'string') {
    return NextResponse.json({ error: 'malformed_body' }, { status: 422 });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // v7.5.0 CRITICAL #3 — defense-in-depth membership gate.
  try {
    await assertActiveMembershipForOrg({ orgId: p.orgId, userId: callerUserId });
  } catch (err) {
    const r = respondToMembershipError(err);
    if (r) return r;
    throw err;
  }

  const norm = normalizeDomain(body.domain);
  if (!norm.ok) {
    return NextResponse.json({ error: 'invalid_domain', reason: norm.reason }, { status: 422 });
  }

  const challengeToken = randomBytes(32).toString('hex');

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc('claim_domain', {
    p_caller_user_id: callerUserId,
    p_org_id: p.orgId,
    p_normalized_domain: norm.domain,
    p_challenge_token: challengeToken,
  });
  if (error) {
    const mapped = mapPostgresError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  const result = data as { id: string; domain: string; status: string; challengeToken: string };
  return NextResponse.json(
    {
      id: result.id,
      domain: result.domain,
      status: result.status,
      challengeRecordName: `_workos-verify.${result.domain}`,
      challengeRecordValue: result.challengeToken,
    },
    { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
