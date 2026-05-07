-- 0007_organization_settings.sql
-- Per-org admin guardrails: org-default model, max budget per user, public-share toggle.

CREATE TABLE public.organization_settings (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  default_model TEXT,
  max_budget_per_user_usd NUMERIC(10,2),
  allow_public_share_links BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;

-- Members read; only admins+owners write.
CREATE POLICY org_settings_select_member ON public.organization_settings
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.organization_id = organization_settings.organization_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  ));

CREATE POLICY org_settings_write_admin ON public.organization_settings
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.organization_id = organization_settings.organization_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner','admin')
      AND m.status = 'active'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.organization_id = organization_settings.organization_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner','admin')
      AND m.status = 'active'
  ));

GRANT ALL ON public.organization_settings TO service_role;
