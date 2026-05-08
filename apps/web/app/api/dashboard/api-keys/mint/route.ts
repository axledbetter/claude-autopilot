import { NextResponse } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { createServerClient as createSsrServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { validateCallbackUrl } from '@/lib/dashboard/callback-url';
import { assertSameOrigin } from '@/lib/dashboard/same-origin';

interface Body { nonce: string; callbackUrl: string; label?: string }

export async function POST(req: Request): Promise<Response> {
  // Mint is cookie-only (no API-key path) — Origin guard is unconditional.
  const so = assertSameOrigin(req);
  if (!so.ok) {
    return NextResponse.json({ error: `forbidden: ${so.reason}` }, { status: 403 });
  }

  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 422 });
  }

  if (!body?.nonce || !/^[0-9a-f]{32}$/.test(body.nonce)) {
    return NextResponse.json({ error: 'invalid nonce' }, { status: 422 });
  }
  if (!validateCallbackUrl(body.callbackUrl)) {
    return NextResponse.json({ error: 'invalid callbackUrl' }, { status: 422 });
  }

  // Supabase SSR session auth.
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return NextResponse.json({ error: 'misconfigured' }, { status: 500 });
  }
  const ssr = createSsrServerClient(url, anon, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await ssr.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const supabase = createServiceRoleClient();

  // Codex plan-pass CRITICAL — atomic mint via single RPC transaction.
  const rawHex = randomBytes(32).toString('hex');
  const rawKey = `clp_${rawHex}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const prefixDisplay = `clp_${rawHex.slice(0, 12)}`;

  const { data, error } = await supabase.rpc('mint_api_key_with_nonce', {
    p_user_id: user.id,
    p_nonce: body.nonce,
    p_key_hash: keyHash,
    p_prefix_display: prefixDisplay,
    p_label: body.label ?? null,
  });
  if (error) {
    if ((error as { code?: string }).code === 'P0010') {
      return NextResponse.json({ error: 'nonce already used; retry the loopback POST' }, { status: 409 });
    }
    return NextResponse.json({ error: 'mint failed' }, { status: 500 });
  }
  const rows = data as Array<{ key_id: string }> | null;
  const keyId = rows?.[0]?.key_id;
  if (!keyId) return NextResponse.json({ error: 'mint returned no rows' }, { status: 500 });

  return NextResponse.json({
    apiKey: rawKey,
    fingerprint: prefixDisplay,
    keyId,
  }, { status: 201 });
}
