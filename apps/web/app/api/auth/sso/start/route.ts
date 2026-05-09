// POST /api/auth/sso/start — Phase 5.6.
//
// Public (anonymous) entry. Body { email }. Resolves org via verified
// domain, generates server-stored state binding + signed cookie,
// returns WorkOS authorize URL.
//
// Codex spec pass-2 WARNING #8 — generic 404 sso_unavailable for ALL
// failure modes (anti-enumeration). Specific reasons logged server-side.

import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { normalizeEmailDomain } from '@/lib/dns/normalize-domain';
import {
  buildAuthorizeUrl,
  getSsoStateSigningSecret,
  signStateCookie,
} from '@/lib/workos/sign-in';

interface Body { email?: unknown }

export const runtime = 'nodejs';

const STATE_TTL_MS = 10 * 60_000;
const SSO_UNAVAILABLE = NextResponse.json(
  { error: 'sso_unavailable' },
  { status: 404, headers: { 'Cache-Control': 'private, no-store' } },
);

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try { body = (await req.json()) as Body; } catch {
    return SSO_UNAVAILABLE;
  }
  if (typeof body.email !== 'string') return SSO_UNAVAILABLE;

  const norm = normalizeEmailDomain(body.email);
  if (!norm.ok) return SSO_UNAVAILABLE;

  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!clientId) {
    // Server misconfig — log but still 404 to caller.
    console.error('[sso-start] WORKOS_CLIENT_ID not set');
    return SSO_UNAVAILABLE;
  }

  const supabase = createServiceRoleClient();

  const { data: claim } = await supabase
    .from('organization_domain_claims')
    .select('organization_id')
    .eq('domain', norm.domain)
    .eq('status', 'verified')
    .maybeSingle();
  if (!claim) return SSO_UNAVAILABLE;
  const orgId = (claim as { organization_id: string }).organization_id;

  const { data: settings } = await supabase
    .from('organization_settings')
    .select('workos_organization_id, workos_connection_id, sso_connection_status')
    .eq('organization_id', orgId)
    .maybeSingle();
  const s = settings as {
    workos_organization_id: string | null;
    workos_connection_id: string | null;
    sso_connection_status: string | null;
  } | null;
  if (!s || s.sso_connection_status !== 'active' || !s.workos_organization_id || !s.workos_connection_id) {
    return SSO_UNAVAILABLE;
  }

  const stateId = randomUUID();
  const nonce = randomBytes(32).toString('hex');
  const nonceHash = createHash('sha256').update(nonce).digest('hex');
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();

  const { error: insertErr } = await supabase
    .from('sso_authentication_states')
    .insert({
      id: stateId,
      nonce: nonceHash,
      organization_id: orgId,
      workos_organization_id: s.workos_organization_id,
      workos_connection_id: s.workos_connection_id,
      initiated_email: body.email,
      expires_at: expiresAt,
    });
  if (insertErr) {
    console.error('[sso-start] state insert failed', insertErr);
    return SSO_UNAVAILABLE;
  }

  const url = new URL(req.url);
  const redirectUri = `${url.origin}/api/auth/sso/callback`;
  let authorizationUrl: string;
  try {
    authorizationUrl = buildAuthorizeUrl({
      workosConnectionId: s.workos_connection_id,
      stateId,
      redirectUri,
      clientId,
    });
  } catch (err) {
    console.error('[sso-start] authorize URL build failed', err);
    return SSO_UNAVAILABLE;
  }

  const signed = signStateCookie({ stateId, nonce }, getSsoStateSigningSecret());
  const res = NextResponse.json(
    { authorizationUrl },
    { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
  );
  res.cookies.set('sso_state', signed, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: Math.floor(STATE_TTL_MS / 1000),
    path: '/',
  });
  return res;
}
