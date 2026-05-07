-- 0005_entitlements.sql
-- Stripe-keyed entitlement records. plan must match organizations.plan exactly
-- (codex final-pass WARNING: drift between the two tables silently breaks
-- enforcement logic).

CREATE TABLE public.entitlements (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  plan TEXT NOT NULL CHECK (plan IN ('free','small','mid','enterprise')),
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- limits example: { "runs_per_month": 1000, "storage_gb": 50, "retention_days": 365 }
  current_period_end TIMESTAMPTZ,
  cancel_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('active','past_due','canceled','trialing')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX entitlements_subscription_idx ON public.entitlements(stripe_subscription_id);

ALTER TABLE public.entitlements ENABLE ROW LEVEL SECURITY;

-- Only org owners + admins can read entitlement details (billing-sensitive).
CREATE POLICY entitlements_select_admin ON public.entitlements
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.organization_id = entitlements.organization_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner','admin')
      AND m.status = 'active'
  ));

-- All writes go through service_role (Stripe webhook handler).
-- Both USING and WITH CHECK = false to deny across SELECT/INSERT/UPDATE/DELETE.
CREATE POLICY entitlements_no_client_write ON public.entitlements
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

GRANT ALL ON public.entitlements TO service_role;
