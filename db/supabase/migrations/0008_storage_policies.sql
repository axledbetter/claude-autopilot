-- 0008_storage_policies.sql
-- Two buckets: 'org-runs' (org-tier, path = org/<org_id>/runs/<run_id>/...)
-- and 'user-runs' (free-tier, path = user/<user_id>/runs/<run_id>/...).
-- Bucket policies enforce path-prefix isolation; RLS on metadata alone isn't enough.

INSERT INTO storage.buckets (id, name, public, file_size_limit) VALUES
  ('org-runs', 'org-runs', false, 52428800),
  ('user-runs', 'user-runs', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- Helper: extract the leading path segment ('org' or 'user') and the next
-- segment (id) from a storage object name.
CREATE OR REPLACE FUNCTION storage.path_prefix_segments(name TEXT)
  RETURNS TABLE (kind TEXT, id TEXT)
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT
    split_part(name, '/', 1) AS kind,
    split_part(name, '/', 2) AS id;
$$;

-- org-runs: read requires active membership in the org whose UUID is segment 2.
CREATE POLICY org_runs_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'org-runs'
    AND (storage.path_prefix_segments(name)).kind = 'org'
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id::text = (storage.path_prefix_segments(name)).id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

-- user-runs: only the owner can read.
CREATE POLICY user_runs_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'user-runs'
    AND (storage.path_prefix_segments(name)).kind = 'user'
    AND (storage.path_prefix_segments(name)).id = auth.uid()::text
  );

-- Writes only via signed upload URL (issued by service_role); clients can't
-- INSERT directly. Codex WARNING: also explicitly deny UPDATE and DELETE
-- (default Supabase grants on storage.objects can otherwise leave mutation
-- surfaces open).
CREATE POLICY org_runs_no_client_write ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY user_runs_no_client_write ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY org_runs_no_client_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'org-runs' AND false)
  WITH CHECK (false);

CREATE POLICY user_runs_no_client_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'user-runs' AND false)
  WITH CHECK (false);

CREATE POLICY org_runs_no_client_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'org-runs' AND false);

CREATE POLICY user_runs_no_client_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'user-runs' AND false);
