-- Phase 3 — Stripe entitlement enforcement.
-- Spec: docs/specs/v7.0-phase3-stripe-entitlements.md (PR #122).

-- Stripe customer mapping per org.
CREATE TABLE billing_customers (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE CHECK (stripe_customer_id ~ '^cus_'),
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;
-- No policies; service-role-only.

-- Augment entitlements.
-- Bugbot HIGH (rebased branch) — column adds MUST come before any
-- UPDATE/INSERT that references runs_per_month_cap or storage_bytes_cap.
-- Postgres parses the whole script and validates column references at
-- parse time, so backfill statements moved AFTER the ALTER TABLE here.
ALTER TABLE entitlements
  ADD COLUMN stripe_customer_id TEXT REFERENCES billing_customers(stripe_customer_id),
  ADD COLUMN stripe_subscription_status TEXT
    CHECK (stripe_subscription_status IS NULL OR stripe_subscription_status IN
      ('trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused')),
  ADD COLUMN current_period_end TIMESTAMPTZ,
  ADD COLUMN cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN cancel_at TIMESTAMPTZ,
  ADD COLUMN payment_failed_at TIMESTAMPTZ,
  ADD COLUMN runs_per_month_cap INTEGER,
  ADD COLUMN storage_bytes_cap BIGINT,
  ADD COLUMN last_stripe_event_at TIMESTAMPTZ;

-- Codex plan-pass CRITICAL #1 — backfill existing rows BEFORE adding the
-- CHECK constraint. Phase 1 may have created `entitlements` rows with NULL
-- caps. Backfill them based on plan to satisfy the new constraint.
-- (No-op on a fresh database.)
UPDATE entitlements SET runs_per_month_cap = 100, storage_bytes_cap = 5368709120
  WHERE plan = 'free' AND runs_per_month_cap IS NULL;
UPDATE entitlements SET runs_per_month_cap = 1000, storage_bytes_cap = 53687091200
  WHERE plan = 'small' AND runs_per_month_cap IS NULL;
UPDATE entitlements SET runs_per_month_cap = 10000, storage_bytes_cap = 536870912000
  WHERE plan = 'mid' AND runs_per_month_cap IS NULL;

-- Insert free entitlement rows for any organizations that don't have one yet.
INSERT INTO entitlements (organization_id, plan, runs_per_month_cap, storage_bytes_cap)
  SELECT id, 'free', 100, 5368709120
  FROM organizations
  WHERE id NOT IN (SELECT organization_id FROM entitlements);

-- Codex pass 2 — free orgs have explicit caps; only enterprise has NULLs.
ALTER TABLE entitlements ADD CONSTRAINT entitlements_plan_caps_check CHECK (
  (plan IN ('free','small','mid') AND runs_per_month_cap IS NOT NULL AND storage_bytes_cap IS NOT NULL) OR
  (plan = 'enterprise' AND runs_per_month_cap IS NULL AND storage_bytes_cap IS NULL)
);

-- Webhook event idempotency with claim/lease/complete pattern.
CREATE TABLE stripe_webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  processing_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '60 seconds'),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX stripe_webhook_events_status_received ON stripe_webhook_events (status, received_at);
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
-- Service-role-only.

-- Personal-tier entitlements (org_id IS NULL flow).
CREATE TABLE personal_entitlements (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  runs_per_month_cap INTEGER NOT NULL DEFAULT 100 CHECK (runs_per_month_cap >= 0),
  storage_bytes_cap BIGINT NOT NULL DEFAULT 5368709120 CHECK (storage_bytes_cap >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE personal_entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY personal_entitlements_select_own ON personal_entitlements
  FOR SELECT USING (user_id = auth.uid());
-- INSERT/UPDATE/DELETE service-role-only.

-- runs.total_bytes (Phase 2.2 finalize already computes; persist now).
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS total_bytes BIGINT NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS runs_org_active ON runs (organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS runs_user_personal_active ON runs (user_id, created_at DESC)
  WHERE organization_id IS NULL AND deleted_at IS NULL;

-- Storage cap aggregate RPC (codex pass 2 WARNING).
CREATE OR REPLACE FUNCTION sum_retained_bytes(
  p_organization_id UUID,
  p_user_id UUID,
  p_retention_days INTEGER DEFAULT 90
) RETURNS BIGINT AS $$
  SELECT COALESCE(SUM(total_bytes), 0)::BIGINT
    FROM public.runs
    WHERE deleted_at IS NULL
      AND created_at >= NOW() - (p_retention_days || ' days')::INTERVAL
      AND (
        (p_organization_id IS NOT NULL AND organization_id = p_organization_id) OR
        (p_organization_id IS NULL AND organization_id IS NULL AND user_id = p_user_id)
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION sum_retained_bytes(UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sum_retained_bytes(UUID, UUID, INTEGER) TO service_role;

-- Run count for current calendar month.
CREATE OR REPLACE FUNCTION count_runs_this_month(
  p_organization_id UUID,
  p_user_id UUID
) RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER
    FROM public.runs
    WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')
      AND (
        (p_organization_id IS NOT NULL AND organization_id = p_organization_id) OR
        (p_organization_id IS NULL AND organization_id IS NULL AND user_id = p_user_id)
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION count_runs_this_month(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION count_runs_this_month(UUID, UUID) TO service_role;

-- Trigger: seed free entitlements row on org creation.
CREATE OR REPLACE FUNCTION seed_free_entitlements() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.plan = 'free' THEN
    INSERT INTO public.entitlements (organization_id, plan, runs_per_month_cap, storage_bytes_cap)
      VALUES (NEW.id, 'free', 100, 5368709120)
      ON CONFLICT (organization_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER organizations_seed_free_entitlements
  AFTER INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION seed_free_entitlements();
