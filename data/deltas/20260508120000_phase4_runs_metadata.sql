-- Phase 4 — UI needs cost/duration/status persisted on runs.
-- Phase 2.2's finalize handler computes total_bytes; this delta extends
-- the same pattern for cost (from state.json), duration (from events.ndjson
-- last - first timestamp), and status (from events.ndjson terminal event).

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 4) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ADD COLUMN IF NOT EXISTS run_status TEXT
    CHECK (run_status IS NULL OR run_status IN ('completed','failed','partial'));

-- Aggregation indexes for cost chart (last 30 days per user/org).
CREATE INDEX IF NOT EXISTS runs_cost_chart_user
  ON runs (user_id, created_at DESC)
  WHERE deleted_at IS NULL AND organization_id IS NULL;
CREATE INDEX IF NOT EXISTS runs_cost_chart_org
  ON runs (organization_id, created_at DESC)
  WHERE deleted_at IS NULL AND organization_id IS NOT NULL;

-- Codex pass 2 CRITICAL — anon SELECT policy for public share-by-URL.
-- Phase 1's RLS does NOT include anon access, so /runs/[runShareId] would
-- return 0 rows even when visibility='public'. Explicit policy here exposes
-- only safe display columns (no events_index_path / state_blob_path /
-- stripe_subscription_id leakage).
--
-- RLS is row-level only — column secrecy comes from the column-level
-- GRANT below. Without the GRANT, anon could SELECT * and read internal
-- metadata even though the policy USING() clause matches.
--
-- Codex pass 3 CRITICAL — policy is anon-only, NOT authenticated. The
-- column-level GRANT below applies to anon; authenticated keeps the broad
-- Phase 1 column grants. Adding `authenticated` to this row policy would
-- let any logged-in user SELECT * on every other user's public runs and
-- read internal columns (events_index_path, state_blob_path, user_id,
-- events_chain_root, organization_id). Public sharing flows through the
-- server-side anon Supabase client in /runs/[runShareId]/page.tsx, so
-- authenticated browsers don't need this policy — they'll either own the
-- row (existing owner/member policy fires) or hit the page anonymously
-- via the same code path the public viewer uses.
CREATE POLICY runs_select_public ON runs
  FOR SELECT TO anon
  USING (visibility = 'public' AND deleted_at IS NULL);

-- Codex plan-pass CRITICAL — anon gets SELECT only on safe public columns,
-- NOT the whole row. organization_id / user_id / events_index_path /
-- state_blob_path / events_chain_root etc. stay restricted.
REVOKE ALL ON runs FROM anon;
GRANT SELECT (
  id, source_verified, cost_usd, duration_ms, run_status,
  total_bytes, created_at, visibility, events_chain_root
) ON runs TO anon;
-- Authenticated keeps its existing GRANTs (Phase 1 schema).

-- Note: this policy is in addition to the existing owner/member SELECT
-- policy from Phase 1, NOT a replacement. RLS uses OR across policies
-- so private rows still flow through the owner branch.
