import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { authViaApiKey } from '@/lib/dashboard/auth';

interface Body { keyId?: string; apiKey?: string }

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

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 422 });
  }

  if (!body || (!body.keyId && !body.apiKey)) {
    return NextResponse.json({ error: 'keyId or apiKey required' }, { status: 422 });
  }
  if (body.apiKey && !/^clp_[0-9a-f]{64}$/.test(body.apiKey)) {
    return NextResponse.json({ error: 'malformed apiKey' }, { status: 422 });
  }

  // Auth — accept API-key bearer OR Supabase session.
  let callerUserId: string | null = null;
  const apiKeyAuth = await authViaApiKey(req);
  if (apiKeyAuth) {
    callerUserId = apiKeyAuth.userId;
  } else {
    callerUserId = await resolveSessionUserId();
  }
  if (!callerUserId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const supabase = createServiceRoleClient();

  // Resolve key row from either keyId or apiKey hash.
  let keyId = body.keyId ?? null;
  let ownerId: string | null = null;

  if (body.apiKey) {
    const hashHex = createHash('sha256').update(body.apiKey).digest('hex');
    const { data } = await supabase.from('api_keys')
      .select('id, user_id, revoked_at')
      .eq('key_hash', hashHex)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const r = data as { id: string; user_id: string; revoked_at: string | null };
    keyId = r.id;
    ownerId = r.user_id;
  } else if (keyId) {
    const { data } = await supabase.from('api_keys')
      .select('id, user_id, revoked_at')
      .eq('id', keyId)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const r = data as { id: string; user_id: string; revoked_at: string | null };
    ownerId = r.user_id;
  }

  if (!keyId || !ownerId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (ownerId !== callerUserId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Idempotent — UPDATE with where revoked_at is null leaves already-revoked alone.
  const { error } = await supabase.from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .is('revoked_at', null);
  if (error) {
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, keyId }, { status: 200 });
}
