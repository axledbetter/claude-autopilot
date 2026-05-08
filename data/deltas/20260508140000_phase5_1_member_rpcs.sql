-- Phase 5.1 — Members management RPCs.
--
-- All writes to memberships + organizations route through these
-- SECURITY DEFINER functions for:
--   1. Atomic FOR UPDATE locking on memberships rows (prevents
--      last-owner TOCTOU race between count check and write)
--   2. Centralized authorization (no RLS-bypass via service-role from
--      route handlers — handlers just translate SQLSTATE → HTTP)
--   3. Same-transaction audit_events writes (audit can never lag the
--      membership change)
--
-- Codex pass 2 CRITICAL: REVOKE FROM authenticated; GRANT service_role
-- ONLY. Routes call via createServiceRoleClient() with p_caller_user_id
-- derived from cookie-verified getUser(). Direct authenticated RPC calls
-- get permission denied (42501) at the GRANT level.

-- ============================================================================
-- invite_member
-- ============================================================================
CREATE OR REPLACE FUNCTION public.invite_member(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_invitee_email text,
  p_role text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_invitee_user_id uuid;
  v_existing memberships%ROWTYPE;
  v_membership memberships%ROWTYPE;
  v_previous_status text;
BEGIN
  -- Validate role argument.
  IF p_role NOT IN ('member', 'admin') THEN
    RAISE EXCEPTION 'bad_role' USING ERRCODE = 'P0001';
  END IF;

  -- Acquire lock FIRST (codex pass 2 CRITICAL #2 — lock before authorize).
  PERFORM 1 FROM memberships
    WHERE organization_id = p_org_id
    FOR UPDATE;

  -- Re-read caller role from locked rows.
  SELECT role INTO v_caller_role
    FROM memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  -- Resolve invitee. Codex pass 1 WARNING — exact lower() comparison.
  SELECT id INTO v_invitee_user_id
    FROM auth.users
   WHERE lower(email) = lower(trim(p_invitee_email))
   LIMIT 1;
  IF v_invitee_user_id IS NULL THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Look up existing membership.
  SELECT * INTO v_existing
    FROM memberships
   WHERE organization_id = p_org_id
     AND user_id = v_invitee_user_id;

  IF FOUND AND v_existing.status = 'active' THEN
    RAISE EXCEPTION 'already_member' USING ERRCODE = 'P0001';
  END IF;

  IF FOUND THEN
    -- Reactivation path.
    v_previous_status := v_existing.status;
    UPDATE memberships
       SET status = 'active',
           role = p_role,
           joined_at = NOW()
     WHERE id = v_existing.id
    RETURNING * INTO v_membership;
  ELSE
    v_previous_status := NULL;
    INSERT INTO memberships (organization_id, user_id, role, status, joined_at)
      VALUES (p_org_id, v_invitee_user_id, p_role, 'active', NOW())
    RETURNING * INTO v_membership;
  END IF;

  -- Audit event in same transaction (codex pass 1 WARNING #2).
  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.member.invited',
    'membership',
    v_membership.id,
    jsonb_build_object('inviteeUserId', v_invitee_user_id, 'role', p_role, 'previousStatus', v_previous_status)
  );

  RETURN jsonb_build_object('membership', to_jsonb(v_membership), 'noop', false);
END;
$$;

-- ============================================================================
-- change_member_role
-- ============================================================================
CREATE OR REPLACE FUNCTION public.change_member_role(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_target_user_id uuid,
  p_new_role text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_target memberships%ROWTYPE;
  v_owner_count int;
  v_membership memberships%ROWTYPE;
  v_old_role text;
BEGIN
  IF p_new_role NOT IN ('member', 'admin', 'owner') THEN
    RAISE EXCEPTION 'bad_role' USING ERRCODE = 'P0001';
  END IF;

  -- Lock all org memberships first.
  PERFORM 1 FROM memberships
    WHERE organization_id = p_org_id
    FOR UPDATE;

  -- Re-read caller role.
  SELECT role INTO v_caller_role
    FROM memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  -- Look up target.
  SELECT * INTO v_target
    FROM memberships
   WHERE organization_id = p_org_id
     AND user_id = p_target_user_id
     AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target_not_member' USING ERRCODE = 'P0001';
  END IF;

  -- Authorization (matrix from spec).
  IF v_caller_role = 'admin' THEN
    -- Admin can manage member↔admin only. Cannot touch owner.
    IF v_target.role = 'owner' OR p_new_role = 'owner' THEN
      RAISE EXCEPTION 'role_transition' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_caller_role = 'owner' THEN
    -- Owner can do any transition subject to last_owner.
    NULL;
  ELSE
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  -- Last-owner safeguard.
  IF v_target.role = 'owner' AND p_new_role <> 'owner' THEN
    SELECT count(*) INTO v_owner_count
      FROM memberships
     WHERE organization_id = p_org_id
       AND role = 'owner'
       AND status = 'active';
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'last_owner' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Idempotent same-role.
  IF v_target.role = p_new_role THEN
    RETURN jsonb_build_object('membership', to_jsonb(v_target), 'noop', true);
  END IF;

  v_old_role := v_target.role;
  UPDATE memberships SET role = p_new_role
    WHERE id = v_target.id
  RETURNING * INTO v_membership;

  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.member.role_changed',
    'membership',
    v_membership.id,
    jsonb_build_object('targetUserId', p_target_user_id, 'oldRole', v_old_role, 'newRole', p_new_role)
  );

  RETURN jsonb_build_object('membership', to_jsonb(v_membership), 'noop', false);
END;
$$;

-- ============================================================================
-- remove_member
-- ============================================================================
CREATE OR REPLACE FUNCTION public.remove_member(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_target_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_target memberships%ROWTYPE;
  v_owner_count int;
  v_membership memberships%ROWTYPE;
BEGIN
  PERFORM 1 FROM memberships
    WHERE organization_id = p_org_id
    FOR UPDATE;

  SELECT role INTO v_caller_role
    FROM memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_target
    FROM memberships
   WHERE organization_id = p_org_id
     AND user_id = p_target_user_id
     AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target_not_member' USING ERRCODE = 'P0001';
  END IF;

  -- Removal matrix: admin can remove member only; owner can remove any.
  IF v_caller_role = 'admin' AND v_target.role <> 'member' THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = 'P0001';
  END IF;

  -- Last-owner safeguard.
  IF v_target.role = 'owner' THEN
    SELECT count(*) INTO v_owner_count
      FROM memberships
     WHERE organization_id = p_org_id
       AND role = 'owner'
       AND status = 'active';
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'last_owner' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE memberships SET status = 'removed'
    WHERE id = v_target.id
  RETURNING * INTO v_membership;

  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.member.removed',
    'membership',
    v_membership.id,
    jsonb_build_object('targetUserId', p_target_user_id, 'previousRole', v_target.role)
  );

  RETURN jsonb_build_object('membership', to_jsonb(v_membership), 'noop', false);
END;
$$;

-- ============================================================================
-- update_org_name
-- ============================================================================
CREATE OR REPLACE FUNCTION public.update_org_name(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_new_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_old_name text;
  v_trimmed text;
  v_org organizations%ROWTYPE;
BEGIN
  v_trimmed := trim(coalesce(p_new_name, ''));
  IF length(v_trimmed) < 1 OR length(v_trimmed) > 100 THEN
    RAISE EXCEPTION 'bad_name' USING ERRCODE = 'P0001';
  END IF;

  -- Codex PR-pass WARNING — explicit org existence check.
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_org_id) THEN
    RAISE EXCEPTION 'org_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Lock org memberships for caller-role check.
  PERFORM 1 FROM memberships
    WHERE organization_id = p_org_id
    FOR UPDATE;

  SELECT role INTO v_caller_role
    FROM memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  -- Codex plan-pass CRITICAL — explicit NULL check.
  -- PL/pgSQL: NULL <> 'owner' evaluates to NULL, not TRUE, so the IF
  -- branch wouldn't fire and a non-member could update org name.
  IF v_caller_role IS NULL OR v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = 'P0001';
  END IF;

  SELECT name INTO v_old_name FROM organizations WHERE id = p_org_id;

  UPDATE organizations SET name = v_trimmed
    WHERE id = p_org_id
  RETURNING * INTO v_org;

  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.settings.updated',
    'organization',
    p_org_id,
    jsonb_build_object('field', 'name', 'oldValue', v_old_name, 'newValue', v_trimmed)
  );

  RETURN jsonb_build_object('organization', to_jsonb(v_org), 'noop', false);
END;
$$;

-- ============================================================================
-- list_org_members_with_emails — Phase 5.1 read RPC.
--
-- Codex PR-pass CRITICAL — direct REST access to auth.users via
-- `supabase.schema('auth').from('users')` is unreliable in production
-- (the auth schema is not normally exposed through PostgREST). Move the
-- membership+email join into a SECURITY DEFINER RPC that authorizes the
-- caller and joins inside Postgres.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.list_org_members_with_emails(
  p_caller_user_id uuid,
  p_org_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_active boolean;
  v_result jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM memberships
     WHERE organization_id = p_org_id
       AND user_id = p_caller_user_id
       AND status = 'active'
  ) INTO v_caller_active;
  IF NOT v_caller_active THEN
    RAISE EXCEPTION 'not_member' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'userId', m.user_id,
    'email', u.email,
    'role', m.role,
    'status', m.status,
    'joinedAt', m.joined_at
  )), '[]'::jsonb)
    INTO v_result
    FROM memberships m
    LEFT JOIN auth.users u ON u.id = m.user_id
   WHERE m.organization_id = p_org_id
     AND m.status = 'active';

  RETURN jsonb_build_object('members', v_result);
END;
$$;

-- ============================================================================
-- Privilege model — codex pass 2 CRITICAL #1
-- Default GRANT EXECUTE TO PUBLIC is implicit. Explicit REVOKE blocks
-- direct authenticated/anon RPC calls; only service-role (used by route
-- handlers) can invoke.
-- ============================================================================
REVOKE ALL ON FUNCTION
  public.invite_member(uuid, uuid, text, text),
  public.change_member_role(uuid, uuid, uuid, text),
  public.remove_member(uuid, uuid, uuid),
  public.update_org_name(uuid, uuid, text),
  public.list_org_members_with_emails(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.invite_member(uuid, uuid, text, text),
  public.change_member_role(uuid, uuid, uuid, text),
  public.remove_member(uuid, uuid, uuid),
  public.update_org_name(uuid, uuid, text),
  public.list_org_members_with_emails(uuid, uuid)
  TO service_role;
