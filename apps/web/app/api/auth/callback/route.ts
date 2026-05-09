// apps/web/app/api/auth/callback/route.ts
//
// PKCE callback for Supabase Auth. Google redirects here with ?code=... after
// the user signs in. We exchange the code for a session (Supabase manages
// PKCE verifier + state correlation internally) and redirect to safeRedirect(next).
//
// Failure modes:
//   - missing `code` query param → /?error=auth_no_code
//   - exchange throws / returns error → /?error=auth_failed
//   - upstream provider sent ?error=... → /?error=<sanitized>
//   - malicious `next` query param → safeRedirect falls back to /

import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { safeRedirect } from '@/lib/auth/redirect';
import { enforceSsoRequired } from '@/lib/auth/enforce-sso-required';

const SAFE_PROVIDER_ERRORS = new Set([
  'access_denied',
  'unauthorized_client',
  'invalid_request',
  'server_error',
  'temporarily_unavailable',
]);

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next');
  const upstreamError = url.searchParams.get('error');

  if (upstreamError) {
    const sanitized = SAFE_PROVIDER_ERRORS.has(upstreamError) ? upstreamError : 'auth_failed';
    return NextResponse.redirect(new URL(`/?error=${sanitized}`, url.origin));
  }

  if (!code) {
    return NextResponse.redirect(new URL('/?error=auth_no_code', url.origin));
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/?error=auth_failed', url.origin));
  }

  // Phase 5.6 — single chokepoint for sso_required enforcement
  // (codex spec pass-2 CRITICAL #1).
  const enforcement = await enforceSsoRequired(data.session?.user?.email);
  if (enforcement.action === 'redirect_to_sso') {
    await supabase.auth.signOut();
    return NextResponse.redirect(
      new URL(`/login/sso?email=${encodeURIComponent(enforcement.email)}&reason=sso_required`, url.origin),
    );
  }

  const target = safeRedirect(next);
  return NextResponse.redirect(new URL(target, url.origin));
}
