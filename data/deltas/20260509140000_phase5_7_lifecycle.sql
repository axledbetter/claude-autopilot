-- Phase 5.7 — Admin lifecycle controls + session revocation.
--
-- Codex spec passes 1+2 + plan-pass folded inline (see spec for details).
-- Highlights:
--   - memberships.status += 'disabled' + disabled_at/by metadata
--   - revoke_user_sessions: DELETE auth.refresh_tokens (Supabase coupling
--     documented in spec; ≤1h access-token expiry latency known)
--   - disable_member: state-transition matrix + owner protection +
--     last-owner guard + idempotent noop. NO API-key revocation
--     (codex pass-2 CRITICAL #1 — cross-tenant blast; deferred to 5.8).
--   - enable_member: symmetric owner protection per pass-2 WARNING #3
--   - cleanup_expired_sso_states: callable RPC, no HTTP route
--   - record_workos_sign_in REPLACE: refuses disabled / inactive /
--     invite_pending memberships
--   - apply_workos_event REPLACE: set-based cascade DELETE on
--     connection.deleted; status IN ('active','disabled') per plan
--     WARNING #1; counts only in audit per plan WARNING #5.
--
-- DEPENDS ON Phase 5.4 (apply_workos_event), Phase 5.6
-- (record_workos_sign_in, sso_authentication_states,
-- workos_user_identities, organization_domain_claims), Phase 2.3
-- (api_keys table — referenced for the deferred-revocation TODO).

-- ============================================================================
-- 1. memberships.status += 'disabled' + lockout metadata.
-- ============================================================================
ALTER TABLE public.memberships
  DROP CONSTRAINT IF EXISTS memberships_status_check,
  ADD CONSTRAINT memberships_status_check
    CHECK (status IN ('pending', 'active', 'inactive', 'disabled'));

ALTER TABLE public.memberships
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disabled_by UUID REFERENCES auth.users(id);

-- ============================================================================
-- 2. revoke_user_sessions — DELETE auth.refresh_tokens for a user.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.revoke_user_sessions(
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public, pg_temp
AS $$
DECLARE
  v_count bigint;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_user_id' USING ERRCODE = 'P0001';
  END IF;

  WITH deleted AS (
    DELETE FROM auth.refresh_tokens
     WHERE user_id::uuid = p_user_id
     RETURNING id
  )
  SELECT count(*) INTO v_count FROM deleted;

  RETURN jsonb_build_object('revokedTokenCount', v_count);
END;
$$;

-- ============================================================================
-- 3. disable_member.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.disable_member(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_target_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_target_role text;
  v_target_membership_id uuid;
  v_target_status text;
  v_revoke_result jsonb;
BEGIN
  IF p_target_user_id = p_caller_user_id THEN
    RAISE EXCEPTION 'cannot_disable_self' USING ERRCODE = 'P0001';
  END IF;

  -- Codex PR-pass CRITICAL #3 — serialize lifecycle mutations per org
  -- via transaction-scoped advisory lock. Without this, two owners
  -- could concurrently disable each other and leave the org with zero
  -- active owners (last-owner check sees the other as still active in
  -- both transactions).
  PERFORM pg_advisory_xact_lock(hashtext('org-lifecycle:' || p_org_id::text));

  SELECT role INTO v_caller_role
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, role, status
    INTO v_target_membership_id, v_target_role, v_target_status
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_target_user_id
   FOR UPDATE;

  IF v_target_membership_id IS NULL THEN
    RAISE EXCEPTION 'target_not_member' USING ERRCODE = 'P0001';
  END IF;

  -- State-transition matrix.
  IF v_target_status = 'disabled' THEN
    RETURN jsonb_build_object(
      'membershipId', v_target_membership_id,
      'status', 'disabled',
      'noop', true,
      'revokedTokenCount', 0,
      'revokedApiKeyCount', 0
    );
  END IF;
  IF v_target_status <> 'active' THEN
    RAISE EXCEPTION 'invalid_status_transition' USING ERRCODE = 'P0001';
  END IF;

  -- Owner protection.
  IF v_target_role = 'owner' AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'cannot_disable_owner' USING ERRCODE = 'P0001';
  END IF;

  -- Last-owner guard.
  IF v_target_role = 'owner' THEN
    PERFORM 1 FROM public.memberships
     WHERE organization_id = p_org_id
       AND status = 'active'
       AND role = 'owner'
       AND user_id <> p_target_user_id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'last_owner' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.memberships
     SET status = 'disabled',
         disabled_at = NOW(),
         disabled_by = p_caller_user_id
   WHERE id = v_target_membership_id;

  v_revoke_result := public.revoke_user_sessions(p_target_user_id);

  -- Codex pass-2 CRITICAL #1 — DROPPED API-key revocation. api_keys are
  -- user-scoped, so revoking in org A would also disable the user's
  -- keys in org B. Phase 5.8 adds membership-active check in the
  -- API-key auth helper instead.

  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.member.disabled',
    'user',
    p_target_user_id::text,
    jsonb_build_object(
      'targetUserId', p_target_user_id,
      'previousRole', v_target_role,
      'previousStatus', v_target_status,
      'revokedTokenCount', v_revoke_result->'revokedTokenCount',
      'revokedApiKeyCount', 0
    ),
    true
  );

  RETURN jsonb_build_object(
    'membershipId', v_target_membership_id,
    'status', 'disabled',
    'noop', false,
    'revokedTokenCount', v_revoke_result->'revokedTokenCount',
    'revokedApiKeyCount', 0
  );
END;
$$;

-- ============================================================================
-- 4. enable_member — symmetric owner protection.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.enable_member(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_target_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_existing_status text;
  v_target_role text;
  v_membership_id uuid;
BEGIN
  SELECT role INTO v_caller_role
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, status, role
    INTO v_membership_id, v_existing_status, v_target_role
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_target_user_id
   FOR UPDATE;
  IF v_membership_id IS NULL THEN
    RAISE EXCEPTION 'target_not_member' USING ERRCODE = 'P0001';
  END IF;
  IF v_existing_status <> 'disabled' THEN
    RAISE EXCEPTION 'invalid_status_transition' USING ERRCODE = 'P0001';
  END IF;

  -- Codex pass-2 WARNING #3 — symmetric owner protection.
  IF v_target_role = 'owner' AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'cannot_enable_owner' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.memberships
     SET status = 'active',
         disabled_at = NULL,
         disabled_by = NULL
   WHERE id = v_membership_id;

  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.member.enabled',
    'user',
    p_target_user_id::text,
    jsonb_build_object(
      'targetUserId', p_target_user_id,
      'targetRole', v_target_role,
      'previousStatus', v_existing_status
    ),
    true
  );

  RETURN jsonb_build_object('membershipId', v_membership_id, 'status', 'active');
END;
$$;

-- ============================================================================
-- 5. cleanup_expired_sso_states.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.cleanup_expired_sso_states(
  p_state_age_hours int DEFAULT 24,
  p_event_age_days int DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state_count bigint;
  v_event_count bigint;
BEGIN
  IF p_state_age_hours < 1 OR p_state_age_hours > 720 THEN
    RAISE EXCEPTION 'invalid_state_age' USING ERRCODE = 'P0001';
  END IF;
  IF p_event_age_days < 1 OR p_event_age_days > 365 THEN
    RAISE EXCEPTION 'invalid_event_age' USING ERRCODE = 'P0001';
  END IF;

  WITH d1 AS (
    DELETE FROM public.sso_authentication_states
     WHERE (consumed_at IS NOT NULL AND consumed_at < NOW() - (p_state_age_hours || ' hours')::interval)
        OR (consumed_at IS NULL AND expires_at < NOW() - (p_state_age_hours || ' hours')::interval)
     RETURNING id
  )
  SELECT count(*) INTO v_state_count FROM d1;

  WITH d2 AS (
    DELETE FROM public.processed_workos_events
     WHERE processed_at IS NOT NULL
       AND processed_at < NOW() - (p_event_age_days || ' days')::interval
     RETURNING event_id
  )
  SELECT count(*) INTO v_event_count FROM d2;

  RETURN jsonb_build_object(
    'expiredStatesDeleted', v_state_count,
    'oldEventsDeleted', v_event_count
  );
END;
$$;

-- ============================================================================
-- 6. record_workos_sign_in REPLACE — refuses disabled/inactive/pending.
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
  v_existing_membership_status text;
  v_membership_created boolean := false;
  v_identity_created boolean := false;
BEGIN
  IF p_email IS NULL OR p_normalized_email_domain IS NULL OR length(trim(p_normalized_email_domain)) = 0 THEN
    RAISE EXCEPTION 'invalid_email' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM public.organization_domain_claims
   WHERE organization_id = p_organization_id
     AND lower(domain) = lower(p_normalized_email_domain)
     AND status = 'verified';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'email_domain_not_claimed_for_org' USING ERRCODE = 'P0001';
  END IF;

  SELECT workos_organization_id INTO v_settings_workos_org
    FROM public.organization_settings
   WHERE organization_id = p_organization_id;
  IF v_settings_workos_org IS NULL OR v_settings_workos_org <> p_workos_organization_id THEN
    RAISE EXCEPTION 'unknown_org' USING ERRCODE = 'P0001';
  END IF;

  -- Identity-link path.
  SELECT user_id INTO v_existing_link_user_id
    FROM public.workos_user_identities
   WHERE workos_user_id = p_workos_user_id
     AND workos_organization_id = p_workos_organization_id;

  IF v_existing_link_user_id IS NOT NULL THEN
    v_local_user_id := v_existing_link_user_id;
  ELSE
    SELECT id INTO v_local_user_id
      FROM auth.users
     WHERE lower(email) = lower(p_email)
     LIMIT 1;
    IF v_local_user_id IS NULL THEN
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

  -- Phase 5.7 — refuse disabled/inactive/pending.
  SELECT status INTO v_existing_membership_status
    FROM public.memberships
   WHERE organization_id = p_organization_id
     AND user_id = v_local_user_id;
  IF v_existing_membership_status = 'disabled' THEN
    RAISE EXCEPTION 'member_disabled' USING ERRCODE = 'P0001';
  END IF;
  IF v_existing_membership_status = 'inactive' THEN
    RAISE EXCEPTION 'member_inactive' USING ERRCODE = 'P0001';
  END IF;
  IF v_existing_membership_status = 'pending' THEN
    RAISE EXCEPTION 'invite_pending' USING ERRCODE = 'P0001';
  END IF;

  IF v_existing_membership_status IS NULL THEN
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
-- 7. apply_workos_event REPLACE — adds set-based cascade on connection.deleted.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_workos_event(
  p_event_id text,
  p_event_type text,
  p_workos_organization_id text,
  p_workos_connection_id text,
  p_event_occurred_at timestamptz,
  p_payload_hash text,
  p_lock_seconds int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_existing_status text;
  v_existing_attempts int;
  v_existing_locked_until timestamptz;
  v_org_id uuid;
  v_settings_status text;
  v_settings_last_event_at timestamptz;
  v_new_status text;
  v_new_connection_id text;
  v_new_disabled_at timestamptz;
  v_new_connected_at timestamptz;
  v_lock_seconds int;
  v_revoked_user_count bigint := 0;
  v_revoked_token_count bigint := 0;
BEGIN
  v_lock_seconds := greatest(coalesce(p_lock_seconds, 60), 10);

  SELECT status, attempt_count, locked_until
    INTO v_existing_status, v_existing_attempts, v_existing_locked_until
    FROM public.processed_workos_events
   WHERE event_id = p_event_id
   FOR UPDATE;

  IF v_existing_status IS NULL THEN
    INSERT INTO public.processed_workos_events (
      event_id, event_type, payload_hash, status,
      processing_started_at, locked_until, attempt_count
    ) VALUES (
      p_event_id, p_event_type, p_payload_hash, 'processing',
      NOW(), NOW() + (v_lock_seconds || ' seconds')::interval, 1
    );
  ELSIF v_existing_status = 'processed' THEN
    RETURN jsonb_build_object('result', 'duplicate', 'eventId', p_event_id);
  ELSIF v_existing_status = 'processing' AND v_existing_locked_until > NOW() THEN
    RETURN jsonb_build_object('result', 'in_flight', 'eventId', p_event_id);
  ELSE
    UPDATE public.processed_workos_events
       SET status = 'processing',
           processing_started_at = NOW(),
           locked_until = NOW() + (v_lock_seconds || ' seconds')::interval,
           attempt_count = v_existing_attempts + 1,
           last_error = NULL
     WHERE event_id = p_event_id;
  END IF;

  SELECT organization_id, sso_connection_status, sso_last_workos_event_at
    INTO v_org_id, v_settings_status, v_settings_last_event_at
    FROM public.organization_settings
   WHERE workos_organization_id = p_workos_organization_id
   FOR UPDATE;

  IF v_org_id IS NULL THEN
    UPDATE public.processed_workos_events
       SET status = 'failed',
           organization_id = NULL,
           last_error = 'unknown_workos_organization',
           locked_until = NULL
     WHERE event_id = p_event_id;
    RETURN jsonb_build_object(
      'result', 'unknown_org',
      'eventId', p_event_id,
      'workosOrganizationId', p_workos_organization_id
    );
  END IF;

  UPDATE public.processed_workos_events
     SET organization_id = v_org_id
   WHERE event_id = p_event_id;

  IF v_settings_last_event_at IS NOT NULL
     AND p_event_occurred_at <= v_settings_last_event_at
     AND p_event_type <> 'dsync.connection.deleted'
     AND p_event_type <> 'connection.deleted' THEN
    UPDATE public.processed_workos_events
       SET status = 'processed',
           processed_at = NOW(),
           last_error = 'stale_event'
     WHERE event_id = p_event_id;
    RETURN jsonb_build_object(
      'result', 'stale_event',
      'eventId', p_event_id,
      'organizationId', v_org_id
    );
  END IF;

  v_new_status := v_settings_status;
  v_new_connection_id := NULL;
  v_new_disabled_at := NULL;
  v_new_connected_at := NULL;

  IF p_event_type IN ('connection.activated', 'dsync.connection.activated') THEN
    v_new_status := 'active';
    v_new_connection_id := p_workos_connection_id;
    v_new_connected_at := NOW();
  ELSIF p_event_type IN ('connection.deactivated', 'dsync.connection.deactivated') THEN
    v_new_status := 'disabled';
    v_new_disabled_at := NOW();
  ELSIF p_event_type IN ('connection.deleted', 'dsync.connection.deleted') THEN
    v_new_status := 'disabled';
    v_new_disabled_at := NOW();
    -- Phase 5.7 — set-based cascade: revoke refresh tokens for all
    -- members (active OR disabled) with verified-domain emails.
    -- Codex plan-pass WARNING #1 — include 'disabled' too.
    -- Codex plan-pass WARNING #5 — counts only in audit, no user IDs.
    WITH affected_users AS (
      SELECT DISTINCT m.user_id
        FROM public.memberships m
        JOIN auth.users u ON u.id = m.user_id
       WHERE m.organization_id = v_org_id
         AND m.status IN ('active', 'disabled')
         AND lower(split_part(u.email, '@', 2)) IN (
           SELECT lower(domain)
             FROM public.organization_domain_claims
            WHERE organization_id = v_org_id
              AND status = 'verified'
         )
    ),
    deleted_tokens AS (
      DELETE FROM auth.refresh_tokens
       WHERE user_id::uuid IN (SELECT user_id FROM affected_users)
       RETURNING id, user_id
    )
    SELECT count(DISTINCT user_id), count(*)
      INTO v_revoked_user_count, v_revoked_token_count
      FROM deleted_tokens;
  ELSE
    UPDATE public.processed_workos_events
       SET status = 'processed',
           processed_at = NOW(),
           last_error = 'unhandled_event_type'
     WHERE event_id = p_event_id;
    RETURN jsonb_build_object(
      'result', 'unhandled_type',
      'eventId', p_event_id,
      'eventType', p_event_type
    );
  END IF;

  UPDATE public.organization_settings
     SET sso_connection_status     = v_new_status,
         sso_connected_at          = COALESCE(v_new_connected_at, sso_connected_at),
         sso_disabled_at           = COALESCE(v_new_disabled_at, sso_disabled_at),
         workos_connection_id      = CASE
           WHEN p_event_type IN ('connection.deleted', 'dsync.connection.deleted') THEN NULL
           WHEN v_new_connection_id IS NOT NULL THEN v_new_connection_id
           ELSE workos_connection_id
         END,
         sso_last_workos_event_at  = p_event_occurred_at,
         sso_last_workos_event_id  = p_event_id,
         updated_at                = NOW()
   WHERE organization_id = v_org_id;

  PERFORM audit.append(
    v_org_id,
    NULL,
    'org.sso.lifecycle',
    'organization',
    v_org_id::text,
    jsonb_build_object(
      'eventId', p_event_id,
      'eventType', p_event_type,
      'workosOrganizationId', p_workos_organization_id,
      'workosConnectionId', p_workos_connection_id,
      'previousStatus', coalesce(v_settings_status, 'inactive'),
      'newStatus', v_new_status,
      'occurredAt', p_event_occurred_at,
      'cascadeRevokedUserCount', v_revoked_user_count,
      'cascadeRevokedTokenCount', v_revoked_token_count
    ),
    true
  );

  UPDATE public.processed_workos_events
     SET status = 'processed',
         processed_at = NOW(),
         locked_until = NULL,
         last_error = NULL
   WHERE event_id = p_event_id;

  RETURN jsonb_build_object(
    'result', 'applied',
    'eventId', p_event_id,
    'organizationId', v_org_id,
    'previousStatus', coalesce(v_settings_status, 'inactive'),
    'newStatus', v_new_status,
    'cascadeRevokedUserCount', v_revoked_user_count,
    'cascadeRevokedTokenCount', v_revoked_token_count
  );
END;
$$;

-- ============================================================================
-- 8. Privilege model.
-- ============================================================================
REVOKE ALL ON FUNCTION
  public.disable_member(uuid, uuid, uuid),
  public.enable_member(uuid, uuid, uuid),
  public.revoke_user_sessions(uuid),
  public.cleanup_expired_sso_states(int, int)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.disable_member(uuid, uuid, uuid),
  public.enable_member(uuid, uuid, uuid),
  public.revoke_user_sessions(uuid),
  public.cleanup_expired_sso_states(int, int)
  TO service_role;

-- record_workos_sign_in + apply_workos_event already revoked/granted in
-- Phase 5.4/5.6 migrations. CREATE OR REPLACE preserves grants.
