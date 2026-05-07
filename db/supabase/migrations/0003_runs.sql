-- 0003_runs.sql
-- Per-run record. Free-tier rows have organization_id IS NULL + user_id set.
-- Org-tier rows have organization_id set (and user_id always set for actor attribution).

CREATE TABLE public.runs (
  id TEXT PRIMARY KEY,  -- ULID from CLI, validated upstream
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cli_version TEXT NOT NULL,
  hostname_hash TEXT,  -- SHA256 of $HOSTNAME, not deanon (collision OK for support triage)
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  total_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  source_verified BOOLEAN NOT NULL DEFAULT FALSE,
  upload_session_id UUID,  -- FK added in 0004
  events_blob_path TEXT,  -- supabase storage key, e.g. 'org/<uuid>/runs/<id>/events.ndjson'
  state_blob_path TEXT,
  events_chain_root TEXT,  -- final hash chain root after upload finalize
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public','org')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX runs_org_started_idx ON public.runs(organization_id, started_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX runs_user_started_idx ON public.runs(user_id, started_at DESC);
CREATE INDEX runs_visibility_idx ON public.runs(visibility) WHERE visibility = 'public';

ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;

-- TWO-BRANCH RLS (codex final-pass WARNING):
-- Branch 1: org-tier — caller is an active member of the run's org.
-- Branch 2: free-tier — row has no org and the caller owns it.
-- Branch 3: public — visibility = 'public' allows anon SELECT (read-only).
CREATE POLICY runs_select_policy ON public.runs
  FOR SELECT
  USING (
    (organization_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = runs.organization_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    ))
    OR
    (organization_id IS NULL AND user_id = auth.uid())
    OR
    (visibility = 'public')
  );

-- Inserts: caller must own the row AND, when org-tier, be an active member of the
-- target org (codex CRITICAL: client-supplied organization_id without membership
-- check would let an authenticated user poison another org's run list).
CREATE POLICY runs_insert_owner ON public.runs
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (
      organization_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.memberships m
        WHERE m.organization_id = runs.organization_id
          AND m.user_id = auth.uid()
          AND m.status = 'active'
      )
    )
  );

-- Updates: same two-branch shape, write requires being owner or admin in org-tier.
CREATE POLICY runs_update_policy ON public.runs
  FOR UPDATE TO authenticated
  USING (
    (organization_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = runs.organization_id
        AND m.user_id = auth.uid()
        AND m.role IN ('owner','admin','member')
        AND m.status = 'active'
    ))
    OR
    (organization_id IS NULL AND user_id = auth.uid())
  );

GRANT ALL ON public.runs TO service_role;
