-- Phase 5.6 — WorkOS SSO sign-in flow.
--
-- Builds on Phase 5.4 (organization_settings SSO columns + processed_workos_events).
-- Adds: domain claim, server-stored sign-in state, identity link table, 6 RPCs.
--
-- Codex spec pass-1 + pass-2 + plan-pass findings folded:
--   - ever_verified flag (CRITICAL pass-1 #1) — verified-then-revoked rows
--     keep their unique-index slot; takeover-via-revoke prevented.
--   - sso_authentication_states table (CRITICAL pass-1 #2 + WARNING pass-1 #5)
--     — server-stored state binding for callback; ECS-safe.
--   - workos_user_identities table (WARNING pass-1 #6) — identity-link by
--     (workos_user_id, workos_organization_id), survives IdP email change.
--   - record_workos_sign_in requires verified-domain match (CRITICAL pass-1 #3).
--   - consume_sso_authentication_state uses atomic UPDATE...RETURNING
--     (WARNING plan-pass #5).
--   - set_sso_required asymmetric guard (WARNING pass-1 #7) — turning OFF
--     allowed any state; turning ON requires active SSO.
--
-- DEPENDS ON Phase 5.4 (organization_settings SSO columns).

-- ============================================================================
-- 1. sso_required toggle on organization_settings.
-- ============================================================================
ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS sso_required BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================================
-- 2. organization_domain_claims.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.organization_domain_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Codex PR-pass CRITICAL #1 — RESTRICT (not CASCADE) on org delete.
  -- Verified-then-revoked rows must survive org deletion to keep
  -- ever_verified ownership intact. Org-delete flow (when added) must
  -- explicitly handle domain claims first.
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'revoked')),
  ever_verified BOOLEAN NOT NULL DEFAULT FALSE,
  challenge_token TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status <> 'verified' OR verified_at IS NOT NULL),
  CHECK (status <> 'revoked'  OR revoked_at  IS NOT NULL),
  CHECK (NOT (ever_verified = TRUE AND verified_at IS NULL))
);

-- Codex pass-1 CRITICAL #1 — unique on ever_verified, not status. Revoked
-- rows still occupy the slot.
CREATE UNIQUE INDEX IF NOT EXISTS organization_domain_claims_owned_domain_idx
  ON public.organization_domain_claims (lower(domain))
  WHERE ever_verified = TRUE;

CREATE INDEX IF NOT EXISTS organization_domain_claims_org_idx
  ON public.organization_domain_claims (organization_id, status);

ALTER TABLE public.organization_domain_claims ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.organization_domain_claims TO service_role;

-- ============================================================================
-- 3. sso_authentication_states.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sso_authentication_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce TEXT NOT NULL,  -- sha256 hex digest of raw nonce
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workos_organization_id TEXT NOT NULL,
  workos_connection_id TEXT NOT NULL,
  initiated_email TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sso_authentication_states_nonce_idx
  ON public.sso_authentication_states (nonce);

CREATE INDEX IF NOT EXISTS sso_authentication_states_expired_idx
  ON public.sso_authentication_states (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE public.sso_authentication_states ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.sso_authentication_states TO service_role;

-- ============================================================================
-- 4. workos_user_identities.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.workos_user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workos_user_id TEXT NOT NULL,
  workos_organization_id TEXT NOT NULL,
  workos_connection_id TEXT NOT NULL,
  email_at_link TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS workos_user_identities_workos_user_org_idx
  ON public.workos_user_identities (workos_user_id, workos_organization_id);

CREATE INDEX IF NOT EXISTS workos_user_identities_user_idx
  ON public.workos_user_identities (user_id);

ALTER TABLE public.workos_user_identities ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.workos_user_identities TO service_role;

-- ============================================================================
-- 5. claim_domain.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claim_domain(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_normalized_domain text,
  p_challenge_token text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_existing_id uuid;
  v_domain_lower text;
  v_new_row public.organization_domain_claims%ROWTYPE;
BEGIN
  IF p_normalized_domain IS NULL OR length(trim(p_normalized_domain)) = 0 THEN
    RAISE EXCEPTION 'invalid_domain' USING ERRCODE = 'P0001';
  END IF;
  IF p_challenge_token IS NULL OR length(p_challenge_token) < 32 THEN
    RAISE EXCEPTION 'invalid_challenge_token' USING ERRCODE = 'P0001';
  END IF;
  v_domain_lower := lower(p_normalized_domain);

  SELECT role INTO v_caller_role
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  -- Codex pass-1 CRITICAL #1 — block if any other org owns (ever_verified)
  -- this domain. Same org with ever_verified is allowed (re-issue challenge
  -- via separate row not yet ever_verified).
  SELECT id INTO v_existing_id
    FROM public.organization_domain_claims
   WHERE lower(domain) = v_domain_lower
     AND ever_verified = TRUE
     AND organization_id <> p_org_id
   LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION 'domain_already_claimed' USING ERRCODE = 'P0001';
  END IF;

  -- Block if a pending claim already exists in THIS org for the same domain
  -- (avoid duplicate active challenges).
  SELECT id INTO v_existing_id
    FROM public.organization_domain_claims
   WHERE lower(domain) = v_domain_lower
     AND organization_id = p_org_id
     AND status = 'pending'
   LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION 'domain_already_pending' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.organization_domain_claims (
    organization_id, domain, status, challenge_token, created_by
  ) VALUES (
    p_org_id, p_normalized_domain, 'pending', p_challenge_token, p_caller_user_id
  )
  RETURNING * INTO v_new_row;

  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.sso.domain.claim_started',
    'organization_domain_claim',
    v_new_row.id::text,
    jsonb_build_object('domain', v_new_row.domain),
    true
  );

  RETURN jsonb_build_object(
    'id', v_new_row.id,
    'domain', v_new_row.domain,
    'status', v_new_row.status,
    'challengeToken', v_new_row.challenge_token
  );
END;
$$;

-- ============================================================================
-- 6. mark_domain_verified.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mark_domain_verified(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_domain_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_claim public.organization_domain_claims%ROWTYPE;
BEGIN
  SELECT role INTO v_caller_role
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_claim
    FROM public.organization_domain_claims
   WHERE id = p_domain_id
     AND organization_id = p_org_id
   FOR UPDATE;
  IF v_claim.id IS NULL THEN
    RAISE EXCEPTION 'domain_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_claim.status = 'verified' THEN
    RETURN jsonb_build_object('id', v_claim.id, 'status', 'verified', 'noop', true);
  END IF;
  IF v_claim.status = 'revoked' THEN
    RAISE EXCEPTION 'domain_revoked' USING ERRCODE = 'P0001';
  END IF;

  -- Atomic flip + ever_verified set. Unique-index on (lower(domain))
  -- WHERE ever_verified=TRUE catches concurrent verify races.
  BEGIN
    UPDATE public.organization_domain_claims
       SET status = 'verified',
           ever_verified = TRUE,
           verified_at = NOW()
     WHERE id = p_domain_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'domain_already_claimed' USING ERRCODE = 'P0001';
  END;

  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.sso.domain.verified',
    'organization_domain_claim',
    v_claim.id::text,
    jsonb_build_object('domain', v_claim.domain),
    true
  );

  RETURN jsonb_build_object('id', v_claim.id, 'status', 'verified', 'noop', false);
END;
$$;

-- ============================================================================
-- 7. revoke_domain_claim.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.revoke_domain_claim(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_domain_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_claim public.organization_domain_claims%ROWTYPE;
BEGIN
  SELECT role INTO v_caller_role
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_claim
    FROM public.organization_domain_claims
   WHERE id = p_domain_id
     AND organization_id = p_org_id
   FOR UPDATE;
  IF v_claim.id IS NULL THEN
    RAISE EXCEPTION 'domain_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_claim.status = 'revoked' THEN
    RETURN jsonb_build_object('id', v_claim.id, 'status', 'revoked', 'noop', true);
  END IF;

  -- ever_verified deliberately preserved (codex pass-1 CRITICAL #1).
  UPDATE public.organization_domain_claims
     SET status = 'revoked',
         revoked_at = NOW()
   WHERE id = p_domain_id;

  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.sso.domain.revoked',
    'organization_domain_claim',
    v_claim.id::text,
    jsonb_build_object('domain', v_claim.domain, 'previousStatus', v_claim.status),
    true
  );

  RETURN jsonb_build_object('id', v_claim.id, 'status', 'revoked', 'noop', false);
END;
$$;

-- ============================================================================
-- 8. set_sso_required (asymmetric guard).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_sso_required(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_required boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_current_status text;
  v_previous boolean;
BEGIN
  SELECT role INTO v_caller_role
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = 'P0001';
  END IF;

  SELECT sso_required, sso_connection_status
    INTO v_previous, v_current_status
    FROM public.organization_settings
   WHERE organization_id = p_org_id
   FOR UPDATE;

  -- Asymmetric guard (codex pass-1 WARNING #7): turning ON requires active
  -- SSO; turning OFF always allowed.
  IF p_required = TRUE AND COALESCE(v_current_status, 'inactive') <> 'active' THEN
    RAISE EXCEPTION 'no_active_sso' USING ERRCODE = 'P0001';
  END IF;

  -- Codex PR-pass WARNING #6 — turning ON also requires at least one
  -- verified domain claim. Without that, /api/auth/sso/start by email
  -- can never resolve and admins lock everyone out.
  IF p_required = TRUE THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_domain_claims
       WHERE organization_id = p_org_id
         AND status = 'verified'
    ) THEN
      RAISE EXCEPTION 'no_verified_domain' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Upsert.
  INSERT INTO public.organization_settings (
    organization_id, sso_required, updated_at, updated_by
  ) VALUES (p_org_id, p_required, NOW(), p_caller_user_id)
  ON CONFLICT (organization_id) DO UPDATE SET
    sso_required = EXCLUDED.sso_required,
    updated_at = NOW(),
    updated_by = p_caller_user_id;

  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.sso.required.toggled',
    'organization',
    p_org_id::text,
    jsonb_build_object('previous', COALESCE(v_previous, false), 'new', p_required),
    true
  );

  RETURN jsonb_build_object('organizationId', p_org_id, 'ssoRequired', p_required);
END;
$$;

-- ============================================================================
-- 9. consume_sso_authentication_state — atomic.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.consume_sso_authentication_state(
  p_state_id uuid,
  p_nonce_hash text,
  p_workos_organization_id text,
  p_workos_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_nonce text;
  v_org_id uuid;
  v_wos_org text;
  v_wos_conn text;
  v_init_email text;
  v_existing_consumed_at timestamptz;
  v_existing_expires_at timestamptz;
BEGIN
  -- Atomic consume — only succeeds if not yet consumed AND not expired.
  UPDATE public.sso_authentication_states
     SET consumed_at = NOW()
   WHERE id = p_state_id
     AND consumed_at IS NULL
     AND expires_at > NOW()
  RETURNING nonce, organization_id, workos_organization_id, workos_connection_id, initiated_email
    INTO v_nonce, v_org_id, v_wos_org, v_wos_conn, v_init_email;

  IF v_nonce IS NULL THEN
    -- Distinguish not_found / expired / already_consumed.
    SELECT consumed_at, expires_at
      INTO v_existing_consumed_at, v_existing_expires_at
      FROM public.sso_authentication_states
     WHERE id = p_state_id;
    IF v_existing_consumed_at IS NULL AND v_existing_expires_at IS NULL THEN
      RAISE EXCEPTION 'state_not_found' USING ERRCODE = 'P0001';
    ELSIF v_existing_consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'state_already_consumed' USING ERRCODE = 'P0001';
    ELSE
      RAISE EXCEPTION 'state_expired' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Verify nonce + workos identifiers (already-consumed-row protection).
  IF v_nonce <> p_nonce_hash THEN
    RAISE EXCEPTION 'state_nonce_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_wos_org <> p_workos_organization_id THEN
    RAISE EXCEPTION 'state_workos_org_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_wos_conn <> p_workos_connection_id THEN
    RAISE EXCEPTION 'state_workos_connection_mismatch' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'stateId', p_state_id,
    'organizationId', v_org_id,
    'initiatedEmail', v_init_email
  );
END;
$$;

-- ============================================================================
-- 10. record_workos_sign_in.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.record_workos_sign_in(
  p_organization_id uuid,
  p_email text,
  p_normalized_email_domain text,
  p_workos_user_id text,
  p_workos_organization_id text,
  p_workos_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_settings_workos_org text;
  v_existing_link_user_id uuid;
  v_local_user_id uuid;
  v_membership_created boolean := false;
  v_identity_created boolean := false;
BEGIN
  IF p_email IS NULL OR p_normalized_email_domain IS NULL OR length(trim(p_normalized_email_domain)) = 0 THEN
    RAISE EXCEPTION 'invalid_email' USING ERRCODE = 'P0001';
  END IF;

  -- Codex pass-1 CRITICAL #3 — verified-domain match is required.
  PERFORM 1
    FROM public.organization_domain_claims
   WHERE organization_id = p_organization_id
     AND lower(domain) = lower(p_normalized_email_domain)
     AND status = 'verified';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'email_domain_not_claimed_for_org' USING ERRCODE = 'P0001';
  END IF;

  -- Verify the resolved local org binds to the same WorkOS org we got from the IdP.
  SELECT workos_organization_id INTO v_settings_workos_org
    FROM public.organization_settings
   WHERE organization_id = p_organization_id;
  IF v_settings_workos_org IS NULL OR v_settings_workos_org <> p_workos_organization_id THEN
    RAISE EXCEPTION 'unknown_org' USING ERRCODE = 'P0001';
  END IF;

  -- Identity-link path (codex pass-1 WARNING #6).
  SELECT user_id INTO v_existing_link_user_id
    FROM public.workos_user_identities
   WHERE workos_user_id = p_workos_user_id
     AND workos_organization_id = p_workos_organization_id;

  IF v_existing_link_user_id IS NOT NULL THEN
    v_local_user_id := v_existing_link_user_id;
  ELSE
    -- Try email fallback (lowercased compare).
    SELECT id INTO v_local_user_id
      FROM auth.users
     WHERE lower(email) = lower(p_email)
     LIMIT 1;
    IF v_local_user_id IS NULL THEN
      -- Route handles auth.admin.createUser then re-runs.
      RETURN jsonb_build_object(
        'result', 'user_not_provisioned',
        'email', p_email,
        'organizationId', p_organization_id
      );
    END IF;
    INSERT INTO public.workos_user_identities (
      user_id, workos_user_id, workos_organization_id, workos_connection_id, email_at_link
    ) VALUES (
      v_local_user_id, p_workos_user_id, p_workos_organization_id, p_workos_connection_id, lower(p_email)
    );
    v_identity_created := true;
  END IF;

  -- Upsert membership.
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships
     WHERE organization_id = p_organization_id
       AND user_id = v_local_user_id
       AND status = 'active'
  ) THEN
    INSERT INTO public.memberships (
      organization_id, user_id, role, status, joined_at
    ) VALUES (
      p_organization_id, v_local_user_id, 'member', 'active', NOW()
    );
    v_membership_created := true;
  END IF;

  PERFORM audit.append(
    p_organization_id,
    v_local_user_id,
    'org.sso.user.signed_in',
    'user',
    v_local_user_id::text,
    jsonb_build_object(
      'email', p_email,
      'workosUserId', p_workos_user_id,
      'workosOrganizationId', p_workos_organization_id,
      'membershipCreated', v_membership_created,
      'identityCreated', v_identity_created
    ),
    true
  );

  RETURN jsonb_build_object(
    'result', 'linked',
    'userId', v_local_user_id,
    'membershipCreated', v_membership_created,
    'identityCreated', v_identity_created
  );
END;
$$;

-- ============================================================================
-- 11. Privilege model.
-- ============================================================================
REVOKE ALL ON FUNCTION
  public.claim_domain(uuid, uuid, text, text),
  public.mark_domain_verified(uuid, uuid, uuid),
  public.revoke_domain_claim(uuid, uuid, uuid),
  public.set_sso_required(uuid, uuid, boolean),
  public.consume_sso_authentication_state(uuid, text, text, text),
  public.record_workos_sign_in(uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.claim_domain(uuid, uuid, text, text),
  public.mark_domain_verified(uuid, uuid, uuid),
  public.revoke_domain_claim(uuid, uuid, uuid),
  public.set_sso_required(uuid, uuid, boolean),
  public.consume_sso_authentication_state(uuid, text, text, text),
  public.record_workos_sign_in(uuid, text, text, text, text, text)
  TO service_role;
