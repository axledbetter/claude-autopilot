-- Phase 5.4 — WorkOS SSO setup foundation.
--
-- Adds durable correlation columns to organization_settings, the
-- processed_workos_events idempotency ledger, and two SECURITY DEFINER
-- RPCs:
--   * record_sso_setup_initiated — server-validated portal-link checkpoint
--     (admin-only; raises workos_org_already_bound if a different active
--     WorkOS org is already mapped).
--   * apply_workos_event — claim/lease/complete + state transition + audit
--     append in one transaction. Lifecycle ordering: events older than
--     sso_last_workos_event_at become no-ops; deleted wins over older
--     updated.
--
-- Codex pass 2 CRITICAL — server-create the WorkOS org BEFORE generating
-- the portal link so the foreign-key correlation is owned by us, not the
-- portal session. The route maps the WorkOS org id and only then calls
-- record_sso_setup_initiated.
--
-- Codex pass 2 CRITICAL — claim/lease/complete (not naive ON CONFLICT DO
-- NOTHING). A processing row may stall mid-transaction; locked_until
-- recovery prevents a webhook retry from being silently dropped.
--
-- DEPENDS ON 0007_organization_settings.sql (organization_settings table)
-- and 0006_audit_events.sql (audit.events / audit.append).

-- ============================================================================
-- 1. Schema delta — organization_settings SSO columns.
-- ============================================================================
ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS workos_organization_id TEXT,
  ADD COLUMN IF NOT EXISTS workos_connection_id TEXT,
  ADD COLUMN IF NOT EXISTS sso_connection_status TEXT
    CHECK (sso_connection_status IN ('inactive', 'pending', 'active', 'disabled')),
  ADD COLUMN IF NOT EXISTS sso_connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sso_disabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sso_last_workos_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sso_last_workos_event_id TEXT;

-- workos_organization_id must be unique when set — one Delegance org per
-- WorkOS org. NULLs allowed for orgs that haven't initiated setup.
CREATE UNIQUE INDEX IF NOT EXISTS organization_settings_workos_organization_id_idx
  ON public.organization_settings (workos_organization_id)
  WHERE workos_organization_id IS NOT NULL;

-- workos_connection_id must be unique when set — webhook lookup key.
CREATE UNIQUE INDEX IF NOT EXISTS organization_settings_workos_connection_id_idx
  ON public.organization_settings (workos_connection_id)
  WHERE workos_connection_id IS NOT NULL;

-- ============================================================================
-- 2. processed_workos_events — idempotency ledger w/ claim/lease/complete.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.processed_workos_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'processed', 'failed')),
  processing_started_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.processed_workos_events ENABLE ROW LEVEL SECURITY;

-- No authenticated/anon access — webhook handler runs under service_role.
GRANT ALL ON public.processed_workos_events TO service_role;

-- Recovery scan: find stale processing rows whose lock has expired.
CREATE INDEX IF NOT EXISTS processed_workos_events_stale_idx
  ON public.processed_workos_events (locked_until)
  WHERE status = 'processing';

-- ============================================================================
-- 3. record_sso_setup_initiated — server-validated portal checkpoint.
--
-- Caller (setup route) has already:
--   1. Verified the org exists and the caller is an active admin/owner.
--   2. Created or fetched the WorkOS org and resolved
--      p_workos_organization_id.
--
-- This RPC enforces:
--   * Caller is admin/owner of p_org_id (defense-in-depth, route already
--     checked).
--   * If a *different* WorkOS org is already mapped AND the connection is
--     active, refuse with workos_org_already_bound. This prevents
--     accidentally swapping an active SSO connection by re-running setup.
--   * Idempotent on retry — re-mapping the same WorkOS org succeeds.
--   * Status flips from inactive→pending; active stays active (re-running
--     setup on an active connection just re-emits the portal link).
--
-- Schema-qualified: public.organization_settings, public.memberships,
-- audit.append. SET search_path locks definer execution.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.record_sso_setup_initiated(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_workos_organization_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_existing_workos_org text;
  v_existing_status text;
  v_new_status text;
BEGIN
  IF p_workos_organization_id IS NULL OR length(trim(p_workos_organization_id)) = 0 THEN
    RAISE EXCEPTION 'bad_workos_org_id' USING ERRCODE = 'P0001';
  END IF;

  -- Authorization: admin/owner only. Phase 5.1 pattern — explicit NULL check.
  SELECT role INTO v_caller_role
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  -- Lock the settings row for the read-modify-write below.
  SELECT workos_organization_id, sso_connection_status
    INTO v_existing_workos_org, v_existing_status
    FROM public.organization_settings
   WHERE organization_id = p_org_id
   FOR UPDATE;

  -- Reassignment guard: if a different WorkOS org is already mapped AND
  -- active, refuse. (pending mappings can be replaced — the user may have
  -- abandoned the portal flow.)
  IF v_existing_workos_org IS NOT NULL
     AND v_existing_workos_org <> p_workos_organization_id
     AND v_existing_status = 'active' THEN
    RAISE EXCEPTION 'workos_org_already_bound' USING ERRCODE = 'P0001';
  END IF;

  -- Status transition: active stays active; everything else → pending.
  v_new_status := CASE
    WHEN v_existing_status = 'active' THEN 'active'
    ELSE 'pending'
  END;

  -- Upsert settings row.
  INSERT INTO public.organization_settings (
    organization_id,
    workos_organization_id,
    sso_connection_status,
    updated_at,
    updated_by
  ) VALUES (
    p_org_id,
    p_workos_organization_id,
    v_new_status,
    NOW(),
    p_caller_user_id
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    workos_organization_id = EXCLUDED.workos_organization_id,
    sso_connection_status  = EXCLUDED.sso_connection_status,
    updated_at             = NOW(),
    updated_by             = p_caller_user_id;

  -- Audit append. source_verified=true (caller has been authn'd by route).
  PERFORM audit.append(
    p_org_id,
    p_caller_user_id,
    'org.sso.setup_initiated',
    'organization',
    p_org_id::text,
    jsonb_build_object(
      'workosOrganizationId', p_workos_organization_id,
      'previousStatus', coalesce(v_existing_status, 'inactive'),
      'newStatus', v_new_status
    ),
    true
  );

  RETURN jsonb_build_object(
    'organizationId', p_org_id,
    'workosOrganizationId', p_workos_organization_id,
    'status', v_new_status
  );
END;
$$;

-- ============================================================================
-- 4. apply_workos_event — claim/lease/complete + lifecycle ordering.
--
-- Webhook route calls this with a verified event payload. RPC handles:
--   1. Claim (INSERT) or recovery (UPDATE expired lock). Returns
--      'duplicate' if event already processed.
--   2. Resolve organization from workos_organization_id. Unknown orgs are
--     marked processed (no-op) and return 'unknown_org'.
--   3. Lifecycle ordering: if p_event_occurred_at <= sso_last_workos_event_at
--      AND the existing row is in a terminal state for that event_type,
--      skip the apply (return 'stale_event'). Deleted always wins over
--      older updated.
--   4. Apply the state transition for the given event_type:
--      * connection.activated     → status=active, connected_at=now
--      * connection.deactivated   → status=disabled, disabled_at=now
--      * connection.deleted       → status=disabled, connection_id=NULL,
--                                   disabled_at=now
--   5. Audit append (source_verified=true — signature was checked).
--   6. Mark event processed.
--
-- All in one transaction. If any step raises, the row stays 'processing'
-- with attempt_count++ and the route returns 5xx so WorkOS retries.
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
BEGIN
  v_lock_seconds := greatest(coalesce(p_lock_seconds, 60), 10);

  -- Step 1: claim or recover the event row.
  SELECT status, attempt_count, locked_until
    INTO v_existing_status, v_existing_attempts, v_existing_locked_until
    FROM public.processed_workos_events
   WHERE event_id = p_event_id
   FOR UPDATE;

  IF v_existing_status IS NULL THEN
    -- Fresh claim.
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
    -- 'failed' or expired-lock 'processing' → re-attempt.
    UPDATE public.processed_workos_events
       SET status = 'processing',
           processing_started_at = NOW(),
           locked_until = NOW() + (v_lock_seconds || ' seconds')::interval,
           attempt_count = v_existing_attempts + 1,
           last_error = NULL
     WHERE event_id = p_event_id;
  END IF;

  -- Step 2: resolve the org. Unknown orgs become no-op processed rows.
  SELECT organization_id, sso_connection_status, sso_last_workos_event_at
    INTO v_org_id, v_settings_status, v_settings_last_event_at
    FROM public.organization_settings
   WHERE workos_organization_id = p_workos_organization_id
   FOR UPDATE;

  IF v_org_id IS NULL THEN
    UPDATE public.processed_workos_events
       SET status = 'processed',
           processed_at = NOW(),
           organization_id = NULL,
           last_error = 'unknown_workos_organization'
     WHERE event_id = p_event_id;
    RETURN jsonb_build_object(
      'result', 'unknown_org',
      'eventId', p_event_id,
      'workosOrganizationId', p_workos_organization_id
    );
  END IF;

  -- Bind org to event row for forensics.
  UPDATE public.processed_workos_events
     SET organization_id = v_org_id
   WHERE event_id = p_event_id;

  -- Step 3: lifecycle ordering. Older events become no-ops UNLESS the
  -- incoming event is connection.deleted (deleted always wins).
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

  -- Step 4: state transition by event type.
  v_new_status := v_settings_status;
  v_new_connection_id := NULL;  -- unchanged unless we set it
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
    -- Clear connection_id on delete — the WorkOS connection is gone.
  ELSE
    -- Unknown event type → no-op processed.
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

  -- Apply settings update. connection_id only updated when set; on delete
  -- we explicitly NULL it.
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

  -- Step 5: audit. source_verified=true (HMAC was checked by route).
  PERFORM audit.append(
    v_org_id,
    NULL,  -- system actor — webhook has no end-user
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
      'occurredAt', p_event_occurred_at
    ),
    true
  );

  -- Step 6: mark processed.
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
    'newStatus', v_new_status
  );
END;
$$;

-- ============================================================================
-- 5. Privilege model — Phase 5.1 codex pass 2 CRITICAL #1 pattern.
--
-- Default GRANT EXECUTE TO PUBLIC is implicit. Explicit REVOKE blocks
-- direct authenticated/anon RPC calls; only service-role (used by route
-- handlers) can invoke.
-- ============================================================================
REVOKE ALL ON FUNCTION
  public.record_sso_setup_initiated(uuid, uuid, text),
  public.apply_workos_event(text, text, text, text, timestamptz, text, int)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.record_sso_setup_initiated(uuid, uuid, text),
  public.apply_workos_event(text, text, text, text, timestamptz, text, int)
  TO service_role;
