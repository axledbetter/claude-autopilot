-- 0001_organizations.sql
-- v7.0 Phase 1 — orgs are the multi-tenant root for the hosted product.
--
-- DEVIATION FROM PLAN (intentional, documented in PR description):
--   1. The `audit` schema is created here (not in 0006) so PostgREST can
--      successfully introspect db-schemas=public,audit,storage at startup.
--      Otherwise `supabase start` enters a reconnect loop because the
--      schema doesn't exist when PostgREST first connects. Migration 0006
--      still owns all audit objects (table, function, grants).
--   2. The `organizations_select_member` and `organizations_update_owner`
--      policies are deferred to 0002 (after `memberships` exists) — the
--      plan's Task 2 Step 2 explicitly authorizes this fallback.

-- Bootstrap the audit schema so PostgREST starts cleanly. Owned by postgres.
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','small','mid','enterprise')),
  declared_size_band TEXT NOT NULL DEFAULT 'small' CHECK (declared_size_band IN ('small','mid','enterprise')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX organizations_slug_idx ON public.organizations(slug);

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- Service role has full access (bypasses RLS entirely — for server-side ops).
GRANT ALL ON public.organizations TO service_role;

-- Member-read + owner-update policies are added in 0002 once `memberships` exists.
