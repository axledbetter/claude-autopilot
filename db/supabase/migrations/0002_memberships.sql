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

-- Members can see their own org's memberships (needed for "who else is on this team").
CREATE POLICY memberships_select_same_org ON public.memberships
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.organization_id = memberships.organization_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  ));

-- Only owners + admins can manage memberships (invite/disable/remove).
-- Codex CRITICAL: FOR ALL with USING alone leaves INSERT/UPDATE row-value checks
-- unenforced — explicit WITH CHECK mirrors the predicate so newly-written rows
-- can't escape the admin gate.
CREATE POLICY memberships_write_admin ON public.memberships
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.organization_id = memberships.organization_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner','admin')
      AND m.status = 'active'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.organization_id = memberships.organization_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner','admin')
      AND m.status = 'active'
  ));

GRANT ALL ON public.memberships TO service_role;

-- Deferred from 0001 — now that memberships exists, attach the org policies.
CREATE POLICY organizations_select_member ON public.organizations
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.organization_id = organizations.id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  ));

CREATE POLICY organizations_update_owner ON public.organizations
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.organization_id = organizations.id
      AND m.user_id = auth.uid()
      AND m.role = 'owner'
      AND m.status = 'active'
  ));
