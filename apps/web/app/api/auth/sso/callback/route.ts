// GET /api/auth/sso/callback — Phase 5.6.
//
// WorkOS OAuth callback. Validates state binding, exchanges code for
// profile, calls record_workos_sign_in (auto-creates user via Supabase
// Admin API if first-time), mints session via admin-mediated magic
// link, sets cookies, redirects to /dashboard.
//
// Codex pass folds:
//   - pass-2 CRITICAL #1: enforceSsoRequired chokepoint applies to
//     /api/auth/callback — this route is SSO-native and exempt.
//   - pass-2 CRITICAL #2: state contract — cookie HMAC + DB nonce_hash
//     + atomic consume_sso_authentication_state.
//   - pass-1 WARNING #6: identity link via workos_user_identities.
//   - pass-1 WARNING #8: verify session.user.id matches expected.
//   - plan-pass CRITICAL #1: req.cookies.get returns object; use .value.
//   - plan-pass CRITICAL #2: verifyOtp returns { data: { user, session }, error }.
//   - plan-pass WARNING #6: clear sso_state cookie on every terminal path.

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { getWorkOS } from '@/lib/workos/client';
import {
  getSsoStateSigningSecret,
  parseStateCookie,
} from '@/lib/workos/sign-in';
import { normalizeEmailDomain } from '@/lib/dns/normalize-domain';
import { mapPostgresError } from '@/lib/dashboard/membership-guard';

export const runtime = 'nodejs';

interface SsoProfile {
  id: string;
  email: string;
  organizationId: string;
  connectionId: string;
  firstName?: string | null;
  lastName?: string | null;
}

function clearStateCookie(res: NextResponse): NextResponse {
  res.cookies.set('sso_state', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  return res;
}

function fail(status: number, body: Record<string, unknown>): NextResponse {
  return clearStateCookie(NextResponse.json(body, { status }));
}

function failRedirect(url: string): NextResponse {
  return clearStateCookie(NextResponse.redirect(url, 302));
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateQuery = url.searchParams.get('state');
  if (!code || !stateQuery) {
    return fail(400, { error: 'missing_code_or_state' });
  }

  // Codex plan-pass CRITICAL #1 — req.cookies.get() returns
  // { name, value } | undefined; must read .value.
  const cookieValue = (req as unknown as {
    cookies: { get: (n: string) => { value?: string } | undefined };
  }).cookies.get('sso_state')?.value;
  const parse = parseStateCookie(cookieValue, getSsoStateSigningSecret());
  if (!parse.ok) {
    return fail(401, { error: 'invalid_state', reason: parse.reason });
  }
  if (parse.payload.stateId !== stateQuery) {
    return fail(401, { error: 'invalid_state', reason: 'state_id_mismatch' });
  }

  // Exchange code for WorkOS profile.
  const workos = getWorkOS();
  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!clientId) {
    console.error('[sso-callback] WORKOS_CLIENT_ID not set');
    return fail(500, { error: 'workos_client_id_missing' });
  }
  let profile: SsoProfile;
  try {
    const result = (await workos.sso.getProfileAndToken({ code, clientId })) as {
      profile: SsoProfile;
    };
    profile = result.profile;
  } catch (err) {
    console.error('[sso-callback] code exchange failed', err);
    return fail(401, { error: 'workos_code_exchange_failed' });
  }

  // Atomic consume of state binding.
  const nonceHash = createHash('sha256').update(parse.payload.nonce).digest('hex');
  const supabase = createServiceRoleClient();
  const { data: consumeData, error: consumeErr } = await supabase.rpc(
    'consume_sso_authentication_state',
    {
      p_state_id: parse.payload.stateId,
      p_nonce_hash: nonceHash,
      p_workos_organization_id: profile.organizationId,
      p_workos_connection_id: profile.connectionId,
    },
  );
  if (consumeErr) {
    const mapped = mapPostgresError(consumeErr);
    return fail(mapped.status, mapped.body);
  }
  const consumed = consumeData as { stateId: string; organizationId: string; initiatedEmail: string | null };

  // Normalize profile email domain — defense-in-depth.
  const norm = normalizeEmailDomain(profile.email);
  if (!norm.ok) {
    console.error('[sso-callback] profile email malformed', { reason: norm.reason });
    return fail(422, { error: 'invalid_email' });
  }

  // record_workos_sign_in. May return user_not_provisioned on first sign-in.
  let userId: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data: rwResult, error: rwErr } = await supabase.rpc('record_workos_sign_in', {
      p_organization_id: consumed.organizationId,
      p_email: profile.email,
      p_normalized_email_domain: norm.domain,
      p_workos_user_id: profile.id,
      p_workos_organization_id: profile.organizationId,
      p_workos_connection_id: profile.connectionId,
    });
    if (rwErr) {
      const mapped = mapPostgresError(rwErr);
      return fail(mapped.status, mapped.body);
    }
    const r = rwResult as
      | { result: 'linked'; userId: string }
      | { result: 'user_not_provisioned'; email: string; organizationId: string };
    if (r.result === 'linked') {
      userId = r.userId;
      break;
    }
    if (attempt === 1) {
      // Already retried after createUser. Should not happen.
      return fail(500, { error: 'user_provisioning_loop' });
    }
    // Try to create the auth.users row.
    const { error: createErr } = await supabase.auth.admin.createUser({
      email: profile.email,
      email_confirm: true,
      user_metadata: {
        workos_user_id: profile.id,
        first_name: profile.firstName ?? null,
        last_name: profile.lastName ?? null,
        source: 'workos_sso',
      },
    });
    if (createErr) {
      const msg = createErr.message ?? '';
      if (msg.toLowerCase().includes('already') || createErr.status === 422) {
        return fail(409, { error: 'user_email_collision' });
      }
      console.error('[sso-callback] createUser failed', createErr);
      return fail(500, { error: 'create_user_failed' });
    }
  }
  if (!userId) return fail(500, { error: 'user_provisioning_failed' });

  // Look up the linked Supabase user's CURRENT email (codex pass-2 WARNING #3).
  const { data: getUserData, error: getUserErr } = await supabase.auth.admin.getUserById(userId);
  if (getUserErr || !getUserData?.user?.email) {
    console.error('[sso-callback] getUserById failed', getUserErr);
    return fail(500, { error: 'linked_user_lookup_failed' });
  }
  const linkedEmail = getUserData.user.email;

  // Generate magic link.
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: linkedEmail,
  });
  const hashedToken = (linkData as { properties?: { hashed_token?: string } } | null)?.properties?.hashed_token;
  if (linkErr || !hashedToken) {
    console.error('[sso-callback] generateLink failed', linkErr);
    return fail(500, { error: 'magic_link_failed' });
  }

  // Consume the magic link via anon client. Codex plan-pass CRITICAL #2 —
  // verifyOtp returns { data: { user, session }, error }.
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const anon = createClient(anonUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: otpData, error: otpErr } = await anon.auth.verifyOtp({
    token_hash: hashedToken,
    type: 'magiclink',
  });
  if (otpErr || !otpData?.user || !otpData?.session) {
    console.error('[sso-callback] verifyOtp failed', otpErr);
    return fail(500, { error: 'verify_otp_failed' });
  }

  // Codex pass-1 WARNING #8 — verify the minted session matches the
  // expected user. On mismatch: revoke + audit + 500.
  if (
    otpData.user.id !== userId
    || otpData.user.email?.toLowerCase() !== linkedEmail.toLowerCase()
  ) {
    try { await supabase.auth.admin.signOut(otpData.session.access_token, 'global'); } catch {}
    await supabase.rpc('audit_append', {
      p_organization_id: consumed.organizationId,
      p_actor_user_id: null,
      p_action: 'org.sso.session.mismatch',
      p_subject_type: 'user',
      p_subject_id: userId,
      p_metadata: {
        expectedUserId: userId,
        actualUserId: otpData.user.id,
        expectedEmail: linkedEmail,
        actualEmail: otpData.user.email ?? null,
      },
      p_source_verified: true,
    });
    return fail(500, { error: 'session_user_mismatch' });
  }

  // Set Supabase session cookies + clear sso_state. Build redirect response
  // first so cookies land on it.
  const dashboardUrl = `${url.origin}/dashboard`;
  const res = NextResponse.redirect(dashboardUrl, 302);
  // Supabase session cookies (sb-<ref>-auth-token).
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF;
  const cookiePrefix = projectRef ? `sb-${projectRef}-auth-token` : 'sb-auth-token';
  const sessionPayload = JSON.stringify([
    otpData.session.access_token,
    otpData.session.refresh_token,
    null,
    null,
    null,
  ]);
  res.cookies.set(cookiePrefix, sessionPayload, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: otpData.session.expires_in,
    path: '/',
  });
  return clearStateCookie(res);
}
