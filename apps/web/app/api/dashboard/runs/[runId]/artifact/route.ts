// GET /api/dashboard/runs/:runId/artifact?kind=manifest|chunk|state[&seq=N]
//
// Phase 4 — authorized signed-URL minter. The `run-uploads` bucket stays
// fully private; all reads go through this endpoint. Visibility check
// gates owner OR (visibility='public' AND kind allowed) before issuing a
// 60s signed URL.
//
// Codex pass 2 NOTE — chunk seq is bounded against actual chunk count
// from upload_session_chunks. Out-of-range → 422 (don't mint a signed URL
// pointing at a non-existent object).
//
// Codex CRITICAL — chunk path derived ONLY from DB-trusted values via
// chunkPath() helper from Phase 2.2; raw `path` query param NEVER accepted.
//
// Public artifact decision (codex pass 2 WARNING): events manifest +
// chunks AND state.json are public for visibility='public' runs (the
// whole point of share-by-URL is "show the events"). UI confirmation
// modal warns when toggling public.

import { NextResponse } from 'next/server';
import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { authViaApiKey } from '@/lib/dashboard/auth';
import { BUCKET, chunkPath } from '@/lib/upload/storage';

interface RunRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  visibility: string | null;
  events_index_path: string | null;
  state_blob_path: string | null;
  source_verified: boolean | null;
  upload_session_id: string | null;
}

interface RouteParams {
  params: Promise<{ runId: string }> | { runId: string };
}

async function resolveCallerUserId(req: Request): Promise<string | null> {
  // Try API key first (CLI / server-to-server), fall back to Supabase
  // session cookie (browser).
  try {
    const apiKey = await authViaApiKey(req);
    if (apiKey) return apiKey.userId;
  } catch {
    // Auth lookup failure — let cookie path try.
  }
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

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  const p = await Promise.resolve(params) as { runId: string };
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind');
  const seqStr = url.searchParams.get('seq');

  if (kind !== 'manifest' && kind !== 'chunk' && kind !== 'state') {
    return NextResponse.json({ error: 'invalid kind' }, { status: 422 });
  }

  const supabase = createServiceRoleClient();
  const { data: runData } = await supabase.from('runs')
    .select('id, user_id, organization_id, visibility, events_index_path, state_blob_path, source_verified, upload_session_id')
    .eq('id', p.runId)
    .maybeSingle();
  if (!runData) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const run = runData as RunRow;

  // Authorization.
  let allowed = false;
  if (run.visibility === 'public') {
    // Anonymous reads OK for ALL kinds (manifest, chunk, state).
    allowed = true;
  } else {
    const callerUserId = await resolveCallerUserId(req);
    if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    if (run.user_id === callerUserId) {
      allowed = true;
    } else if (run.organization_id) {
      const { data: m } = await supabase.from('memberships')
        .select('user_id')
        .eq('organization_id', run.organization_id)
        .eq('user_id', callerUserId)
        .eq('status', 'active')
        .maybeSingle();
      if (m) allowed = true;
    }
  }
  if (!allowed) {
    // 404 not 403 to avoid enumeration.
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // Resolve the storage path. Trust only DB-derived values.
  let storagePath: string;
  if (kind === 'manifest') {
    storagePath = run.events_index_path ?? '';
  } else if (kind === 'state') {
    storagePath = run.state_blob_path ?? '';
  } else {
    // kind === 'chunk' — bound seq against actual chunk count.
    const seq = Number.parseInt(seqStr ?? '', 10);
    if (!Number.isInteger(seq) || seq < 0) {
      return NextResponse.json({ error: 'invalid seq' }, { status: 422 });
    }
    if (!run.upload_session_id) {
      return NextResponse.json({ error: 'artifact not finalized' }, { status: 404 });
    }
    const countResult = await supabase.from('upload_session_chunks')
      .select('seq', { count: 'exact', head: true })
      .eq('session_id', run.upload_session_id)
      .eq('status', 'persisted');
    const count = (countResult as { count?: number }).count;
    if (typeof count !== 'number' || seq >= count) {
      return NextResponse.json({ error: 'seq out of range' }, { status: 422 });
    }
    storagePath = chunkPath({ organizationId: run.organization_id, userId: run.user_id }, p.runId, seq);
  }

  if (!storagePath) {
    return NextResponse.json({ error: 'artifact not finalized' }, { status: 404 });
  }

  // Mint signed URL (60s TTL).
  const signRes = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60);
  // supabase-js: { data: { signedUrl } | null, error: ... | null }
  const signed = (signRes as { data: { signedUrl?: string } | null; error: unknown }).data;
  const signError = (signRes as { error: { message?: string } | null }).error;
  if (signError || !signed?.signedUrl) {
    return NextResponse.json({ error: 'sign failed' }, { status: 500 });
  }
  return NextResponse.json({
    url: signed.signedUrl,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { status: 200 });
}
