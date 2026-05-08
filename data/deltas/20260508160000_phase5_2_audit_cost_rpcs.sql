-- Phase 5.2 — read RPCs for audit log viewer + cost report.
--
-- Same pattern as Phase 5.1: SECURITY DEFINER, REVOKE FROM authenticated,
-- GRANT service_role only. Routes pass p_caller_user_id from cookie-verified
-- getUser(). Direct authenticated RPC calls fail with 42501.
--
-- DEPENDS ON Phase 4 (`20260508120000_phase4_runs_metadata.sql`) for
-- `runs.cost_usd`, `runs.duration_ms`. Filename timestamp ordering enforces
-- this; the privilege grep test asserts the Phase 4 file exists.
--
-- Codex plan-pass CRITICAL — schema-qualify audit.events, public.runs,
-- public.memberships, auth.users in all SQL bodies. SET search_path locks
-- definer execution to public, audit, auth, pg_temp.

-- Index supports keyset access pattern for audit list pagination.
CREATE INDEX IF NOT EXISTS audit_events_org_keyset_idx
  ON audit.events (organization_id, occurred_at DESC, id DESC);

-- ============================================================================
-- list_audit_events
-- ============================================================================
CREATE OR REPLACE FUNCTION public.list_audit_events(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_cursor_occurred_at timestamptz,
  p_cursor_id bigint,
  p_limit int,
  p_action text,
  p_actor_user_id uuid,
  p_since timestamptz,
  p_until timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_limit int;
  v_events jsonb;
  v_next_cursor jsonb;
BEGIN
  -- Authorization first.
  SELECT role INTO v_caller_role
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  -- Server-side limit clamp [1, 200].
  v_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  -- Fetch limit+1 to detect if there's a next page.
  WITH page_rows AS (
    SELECT e.id,
           e.action,
           e.actor_user_id,
           u.email AS actor_email,
           e.subject_type,
           e.subject_id,
           e.metadata,
           e.occurred_at,
           e.prev_hash,
           e.this_hash
      FROM audit.events e
      LEFT JOIN auth.users u ON u.id = e.actor_user_id
     WHERE e.organization_id = p_org_id
       AND (p_cursor_occurred_at IS NULL OR
            (e.occurred_at, e.id) < (p_cursor_occurred_at, p_cursor_id))
       AND (p_action IS NULL OR e.action = p_action)
       AND (p_actor_user_id IS NULL OR e.actor_user_id = p_actor_user_id)
       AND (p_since IS NULL OR e.occurred_at >= p_since)
       AND (p_until IS NULL OR e.occurred_at <  p_until)
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT v_limit + 1
  ),
  ranked AS (
    SELECT pr.*, row_number() OVER (ORDER BY pr.occurred_at DESC, pr.id DESC) AS rn
      FROM page_rows pr
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id,
      'action', r.action,
      'actorUserId', r.actor_user_id,
      'actorEmail', r.actor_email,
      'subjectType', r.subject_type,
      'subjectId', r.subject_id,
      'metadata', r.metadata,
      'occurredAt', r.occurred_at,
      'prevHash', r.prev_hash,
      'thisHash', r.this_hash
    ) ORDER BY r.occurred_at DESC, r.id DESC) FILTER (WHERE r.rn <= v_limit), '[]'::jsonb),
    -- nextCursor = the row at position v_limit (1-indexed) when there's a +1th row.
    (SELECT jsonb_build_object('occurredAt', r2.occurred_at, 'id', r2.id)
       FROM ranked r2
      WHERE r2.rn = v_limit
        AND EXISTS (SELECT 1 FROM ranked WHERE rn = v_limit + 1))
  INTO v_events, v_next_cursor
  FROM ranked r;

  RETURN jsonb_build_object('events', v_events, 'nextCursor', v_next_cursor);
END;
$$;

-- ============================================================================
-- org_cost_report
-- ============================================================================
CREATE OR REPLACE FUNCTION public.org_cost_report(
  p_caller_user_id uuid,
  p_org_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_group_by text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, audit, auth, pg_temp
AS $$
DECLARE
  v_caller_role text;
  v_rows jsonb;
  v_total jsonb;
BEGIN
  IF p_group_by IS NULL OR p_group_by <> 'user' THEN
    RAISE EXCEPTION 'bad_group_by' USING ERRCODE = 'P0001';
  END IF;

  SELECT role INTO v_caller_role
    FROM public.memberships
   WHERE organization_id = p_org_id
     AND user_id = p_caller_user_id
     AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;

  WITH agg AS (
    SELECT
      r.user_id,
      count(*)                                              AS run_count,
      coalesce(sum(coalesce(r.cost_usd, 0)), 0)             AS cost_usd_sum,
      coalesce(sum(coalesce(r.duration_ms, 0)), 0)::bigint  AS duration_ms_sum,
      coalesce(sum(coalesce(r.total_bytes, 0)), 0)::bigint  AS total_bytes_sum,
      max(r.created_at)                                     AS last_run_at
    FROM public.runs r
    WHERE r.organization_id = p_org_id
      AND r.deleted_at IS NULL
      AND r.created_at >= p_since
      AND r.created_at <  p_until
    GROUP BY r.user_id
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'user_id', a.user_id,
      'email', u.email,
      'run_count', a.run_count,
      'cost_usd_sum', a.cost_usd_sum,
      'duration_ms_sum', a.duration_ms_sum,
      'total_bytes_sum', a.total_bytes_sum,
      'last_run_at', a.last_run_at
    ) ORDER BY a.cost_usd_sum DESC, a.user_id), '[]'::jsonb),
    jsonb_build_object(
      'run_count',       coalesce(sum(a.run_count), 0),
      'cost_usd_sum',    coalesce(sum(a.cost_usd_sum), 0),
      'duration_ms_sum', coalesce(sum(a.duration_ms_sum), 0)::bigint,
      'total_bytes_sum', coalesce(sum(a.total_bytes_sum), 0)::bigint
    )
  INTO v_rows, v_total
  FROM agg a
  LEFT JOIN auth.users u ON u.id = a.user_id;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'period', jsonb_build_object('since', p_since, 'until', p_until)
  );
END;
$$;

-- ============================================================================
-- Privilege model — codex 5.1 pattern.
-- ============================================================================
REVOKE ALL ON FUNCTION
  public.list_audit_events(uuid, uuid, timestamptz, bigint, int, text, uuid, timestamptz, timestamptz),
  public.org_cost_report(uuid, uuid, timestamptz, timestamptz, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.list_audit_events(uuid, uuid, timestamptz, bigint, int, text, uuid, timestamptz, timestamptz),
  public.org_cost_report(uuid, uuid, timestamptz, timestamptz, text)
  TO service_role;
