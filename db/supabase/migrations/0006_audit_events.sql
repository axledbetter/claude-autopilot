-- 0006_audit_events.sql
-- Tamper-evident audit log. Writes flow through `audit.append(...)`. App roles
-- cannot UPDATE or DELETE — only INSERT through the function (which itself
-- enforces the hash chain).
--
-- NOTE: the `audit` schema itself is created in 0001 (PostgREST bootstrap
-- ordering — see 0001 deviation note). All other audit objects live here.

-- pgcrypto provides digest() — required by audit.append() below.
-- Codex CRITICAL: must be created BEFORE the function references it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE audit.events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,  -- e.g. 'run.uploaded', 'membership.disabled', 'plan.upgraded'
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_verified BOOLEAN NOT NULL,
  prev_hash TEXT,  -- prior chain entry's this_hash (NULL for first-ever entry per org)
  this_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_events_org_occurred_idx ON audit.events(organization_id, occurred_at DESC);
CREATE INDEX audit_events_subject_idx ON audit.events(subject_type, subject_id);

ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;

-- Org admins can read their org's audit log.
CREATE POLICY audit_events_select_admin ON audit.events
  FOR SELECT TO authenticated
  USING (
    organization_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = audit.events.organization_id
        AND m.user_id = auth.uid()
        AND m.role IN ('owner','admin')
        AND m.status = 'active'
    )
  );

-- App roles get no direct DML privileges; everything goes through audit.append().
REVOKE ALL ON audit.events FROM authenticated, anon;
GRANT SELECT ON audit.events TO authenticated;  -- RLS still applies above
GRANT ALL ON audit.events TO service_role;
GRANT USAGE ON SCHEMA audit TO authenticated, service_role;

-- The append function. SECURITY DEFINER so authenticated callers can append
-- without direct INSERT grants, while still being subject to the function's
-- own validation.
CREATE OR REPLACE FUNCTION audit.append(
  p_organization_id UUID,
  p_actor_user_id UUID,
  p_action TEXT,
  p_subject_type TEXT,
  p_subject_id TEXT,
  p_metadata JSONB,
  p_source_verified BOOLEAN
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, public
AS $$
DECLARE
  v_prev_hash TEXT;
  v_this_hash TEXT;
  v_payload TEXT;
  v_new_id BIGINT;
  v_caller_role TEXT;
  v_resolved_actor UUID;
BEGIN
  -- Codex CRITICAL: forbid actor impersonation. Authenticated callers cannot
  -- pass arbitrary p_actor_user_id — we force it to auth.uid(). Only
  -- service_role (server-side) can pass an arbitrary actor (for backfills /
  -- system events). The check uses the calling role, not the SECURITY DEFINER
  -- role of the function itself.
  v_caller_role := current_setting('request.jwt.claims', true)::jsonb->>'role';
  IF v_caller_role = 'service_role' THEN
    v_resolved_actor := p_actor_user_id;
  ELSE
    -- authenticated or anon: pin actor to caller's auth.uid().
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'audit.append requires an authenticated caller or service_role';
    END IF;
    IF p_actor_user_id IS NOT NULL AND p_actor_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'audit.append cannot impersonate another user (got %, expected %)',
        p_actor_user_id, auth.uid();
    END IF;
    v_resolved_actor := auth.uid();
  END IF;

  -- Look up the prior chain entry for this org (or for the global chain when org is NULL).
  SELECT this_hash INTO v_prev_hash
  FROM audit.events
  WHERE (p_organization_id IS NULL AND organization_id IS NULL)
     OR (p_organization_id IS NOT NULL AND organization_id = p_organization_id)
  ORDER BY id DESC
  LIMIT 1;

  -- Build the payload that the chain hashes over (uses resolved actor, not raw input).
  v_payload := concat_ws('|',
    coalesce(p_organization_id::text, ''),
    coalesce(v_resolved_actor::text, ''),
    p_action,
    p_subject_type,
    p_subject_id,
    p_metadata::text,
    p_source_verified::text,
    coalesce(v_prev_hash, '')
  );

  v_this_hash := encode(digest(v_payload, 'sha256'), 'hex');

  INSERT INTO audit.events (
    organization_id, actor_user_id, action, subject_type, subject_id,
    metadata, source_verified, prev_hash, this_hash
  ) VALUES (
    p_organization_id, v_resolved_actor, p_action, p_subject_type, p_subject_id,
    p_metadata, p_source_verified, v_prev_hash, v_this_hash
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION audit.append TO authenticated, service_role;

-- Public-schema wrapper so supabase-js can call it via .rpc('audit_append', ...)
-- without needing to flip the schema accessor (PostgREST exposes only the
-- schemas in api.schemas; functions in non-default schemas need either a
-- wrapper here or a per-call .schema('audit') accessor — wrapper is simpler
-- and lets us audit which call site is invoking what).
CREATE OR REPLACE FUNCTION public.audit_append(
  p_organization_id UUID,
  p_actor_user_id UUID,
  p_action TEXT,
  p_subject_type TEXT,
  p_subject_id TEXT,
  p_metadata JSONB,
  p_source_verified BOOLEAN
) RETURNS BIGINT
LANGUAGE sql
SECURITY INVOKER  -- SECURITY DEFINER lives on audit.append; wrapper is invoker
AS $$
  SELECT audit.append(
    p_organization_id, p_actor_user_id, p_action,
    p_subject_type, p_subject_id, p_metadata, p_source_verified
  );
$$;

GRANT EXECUTE ON FUNCTION public.audit_append TO authenticated, service_role;

-- Test-only helper: service_role calls this to reset all v7.0 tables between
-- test files. NEVER granted to authenticated/anon. The CI workflow runs
-- `db:reset` between test files which is the primary isolation mechanism;
-- this is the in-test fast-path when full reset is overkill.
CREATE OR REPLACE FUNCTION public.test_reset_all_tables() RETURNS VOID
  LANGUAGE plpgsql SECURITY DEFINER AS $$
  BEGIN
    TRUNCATE
      audit.events,
      public.organization_settings,
      public.entitlements,
      public.upload_sessions,
      public.runs,
      public.memberships,
      public.organizations
    RESTART IDENTITY CASCADE;
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.test_reset_all_tables FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.test_reset_all_tables TO service_role;
