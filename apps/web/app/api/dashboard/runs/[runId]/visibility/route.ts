// PATCH /api/dashboard/runs/:runId/visibility — Phase 4.
//
// Narrow endpoint with explicit owner check; we deliberately do NOT let
// the client UPDATE arbitrary `runs` columns. RLS would also catch a
// non-owner UPDATE attempt, but the explicit gate here is the cleaner
// contract and lets us return 404 (not 403) to avoid enumeration.
//
// Auth: Supabase session cookie (cookie-only). assertSameOrigin guard
// runs first to block CSRF.

import { NextResponse } from 'next/server';
import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';

interface Body { visibility: string }

interface RouteParams {
  params: Promise<{ runId: string }> | { runId: string };
}

async function resolveSessionUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return null;
    const ssr = createSsrServerClient(url, anon, {
      cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
    });
    const { data: { user } } = await ssr.auth.getUser();
    return user?.id ?? null;
  } catch {
    return null;
  }
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  // CSRF guard first — cheap, fails closed.
  const so = assertSameOrigin(req);
  if (!so.ok) return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });

  const p = await Promise.resolve(params) as { runId: string };

  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 422 });
  }
  if (body?.visibility !== 'public' && body?.visibility !== 'private') {
    return NextResponse.json({ error: 'invalid visibility' }, { status: 422 });
  }

  const callerUserId = await resolveSessionUserId();
  if (!callerUserId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  // Codex pass 3 CRITICAL — refuse to flip visibility on soft-deleted runs.
  // Otherwise an owner could re-publish a deleted run and the artifact
  // route would still mint signed URLs (until that route's deleted_at
  // check rejects). Belt-and-suspenders: check both here.
  const { data: run } = await supabase.from('runs')
    .select('user_id, deleted_at')
    .eq('id', p.runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const r = run as { user_id: string; deleted_at: string | null };
  // Truthy check on deleted_at: null = active, any string timestamp = deleted.
  if (r.user_id !== callerUserId || r.deleted_at) {
    // 404 (not 403) to avoid enumerating which run IDs exist.
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const { error } = await supabase.from('runs')
    .update({ visibility: body.visibility })
    .eq('id', p.runId)
    .is('deleted_at', null);
  if (error) {
    return NextResponse.json({ error: 'update failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, visibility: body.visibility }, { status: 200 });
}
