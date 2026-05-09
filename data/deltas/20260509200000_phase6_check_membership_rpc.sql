-- Phase 6 — middleware membership-revocation RPC.
--
-- Single read used by apps/web/middleware.ts on every /dashboard/** and
-- /api/dashboard/** request that resolves an active org cookie. Returns
-- the current membership row (status + role) for (org_id, user_id), or a
-- synthetic 'no_row' status when the membership doesn't exist.
--
-- Per spec § "RPC contract":
--   - SECURITY INVOKER (NOT DEFINER) — service_role bypasses RLS already,
--     so DEFINER would only widen blast radius if grants are accidentally
--     extended to authenticated later. (codex pass-2 WARNING #5,
--     pass-3 WARNING #2)
--   - Returns ONE row always: COALESCE the lookup with a synthetic
--     'no_row' object so the helper never sees null. (codex pass-1 NOTE #2)
--   - REVOKE FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO
--     service_role only.
--
-- Status values from production memberships table:
--   active          → middleware passes
--   disabled        → 302 /access-revoked?reason=member_disabled / 403
--   inactive        → 302 /access-revoked?reason=member_inactive / 403
--   invite_pending  → mapped to member_inactive in middleware
--   no_row (synth)  → mapped to no_membership in middleware

CREATE OR REPLACE FUNCTION public.check_membership_status(
  p_org_id uuid,
  p_user_id uuid
) RETURNS json
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (
      SELECT json_build_object(
        'status', status,
        'role', role,
        'checked_at', extract(epoch from now())::int
      )
      FROM public.memberships
      WHERE organization_id = p_org_id
        AND user_id = p_user_id
      LIMIT 1
    ),
    json_build_object(
      'status', 'no_row',
      'role', NULL,
      'checked_at', extract(epoch from now())::int
    )
  )
$$;

REVOKE ALL ON FUNCTION public.check_membership_status(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_membership_status(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.check_membership_status(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_membership_status(uuid, uuid) TO service_role;
