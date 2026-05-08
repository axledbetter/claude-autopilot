// POST /api/dashboard/active-org — Phase 5.3.
//
// Sets the cao_active_org cookie. Body { orgId: string | null }.
// Validates caller is active member; clears cookie when null.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';
import { resolveSessionUserId, isValidUuid } from '@/lib/dashboard/membership-guard';
import { ACTIVE_ORG_COOKIE } from '@/lib/dashboard/active-org';

const NO_STORE = { 'cache-control': 'private, no-store' } as const;
const COOKIE_MAX_AGE = 60 * 60 * 24 * 14;  // 14 days

interface Body { orgId: string | null }

export async function POST(req: Request): Promise<Response> {
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403, headers: NO_STORE });

  let body: Body;
  try { body = await req.json() as Body; } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 422, headers: NO_STORE }); }
  if (body == null || (body.orgId !== null && typeof body.orgId !== 'string')) {
    return NextResponse.json({ error: 'malformed_body' }, { status: 422, headers: NO_STORE });
  }
  if (body.orgId !== null && !isValidUuid(body.orgId)) {
    return NextResponse.json({ error: 'malformed_params' }, { status: 422, headers: NO_STORE });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE });

  const cookieStore = await cookies();

  if (body.orgId === null) {
    cookieStore.set(ACTIVE_ORG_COOKIE, '', {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0,
    });
    return NextResponse.json({ ok: true, cleared: true }, { status: 200, headers: NO_STORE });
  }

  const supabase = createServiceRoleClient();
  const { data: membership } = await supabase.from('memberships')
    .select('id')
    .eq('organization_id', body.orgId)
    .eq('user_id', callerUserId)
    .eq('status', 'active')
    .maybeSingle();
  if (!membership) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  cookieStore.set(ACTIVE_ORG_COOKIE, body.orgId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
  return NextResponse.json({ ok: true, orgId: body.orgId }, { status: 200, headers: NO_STORE });
}
