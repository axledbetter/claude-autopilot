-- 0002_memberships.sql
-- Join table between organizations and auth.users with role + status.
-- Also adds the deferred org-table policies that depend on this table.

CREATE TABLE public.memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','removed')),
  invited_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX memberships_user_idx ON public.memberships(user_id) WHERE status = 'active';
CREATE INDEX memberships_org_idx ON public.memberships(organization_id) WHERE status = 'active';

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER helpers — necessary to break infinite-recursion in
-- memberships RLS policies. A policy on memberships that directly EXISTS-
-- queries memberships re-triggers the same policy → infinite recursion. The
-- helpers run with definer privileges and bypass RLS for the membership
-- lookup, breaking the cycle while still expressing the same predicate.
CREATE OR REPLACE FUNCTION public.user_is_active_member(p_org_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = p_org_id
      AND user_id = p_user_id
      AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.user_is_org_admin(p_org_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = p_org_id
      AND user_id = p_user_id
      AND role IN ('owner','admin')
      AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.user_is_org_owner(p_org_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = p_org_id
      AND user_id = p_user_id
      AND role = 'owner'
      AND status = 'active'
  );
$$;

GRANT EXECUTE ON FUNCTION
  public.user_is_active_member(UUID, UUID),
  public.user_is_org_admin(UUID, UUID),
  public.user_is_org_owner(UUID, UUID)
  TO authenticated, service_role;

-- Members can see their own org's memberships (needed for "who else is on this team").
CREATE POLICY memberships_select_same_org ON public.memberships
  FOR SELECT TO authenticated
  USING (public.user_is_active_member(organization_id, auth.uid()));

-- Only owners + admins can manage memberships (invite/disable/remove).
-- Codex CRITICAL: FOR ALL with USING alone leaves INSERT/UPDATE row-value checks
-- unenforced — explicit WITH CHECK mirrors the predicate so newly-written rows
-- can't escape the admin gate.
CREATE POLICY memberships_write_admin ON public.memberships
  FOR ALL TO authenticated
  USING (public.user_is_org_admin(organization_id, auth.uid()))
  WITH CHECK (public.user_is_org_admin(organization_id, auth.uid()));

GRANT ALL ON public.memberships TO service_role;

-- Deferred from 0001 — now that memberships exists, attach the org policies.
-- Use the SECURITY DEFINER helpers to keep the bypass-RLS pattern consistent.
CREATE POLICY organizations_select_member ON public.organizations
  FOR SELECT TO authenticated
  USING (public.user_is_active_member(organizations.id, auth.uid()));

CREATE POLICY organizations_update_owner ON public.organizations
  FOR UPDATE TO authenticated
  USING (public.user_is_org_owner(organizations.id, auth.uid()));
