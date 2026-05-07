-- 0008_storage_policies.sql
-- Two buckets: 'org-runs' (org-tier, path = org/<org_id>/runs/<run_id>/...)
-- and 'user-runs' (free-tier, path = user/<user_id>/runs/<run_id>/...).
-- Bucket policies enforce path-prefix isolation; RLS on metadata alone isn't enough.

INSERT INTO storage.buckets (id, name, public, file_size_limit) VALUES
  ('org-runs', 'org-runs', false, 52428800),
  ('user-runs', 'user-runs', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- Path-prefix logic is inlined into each policy below via split_part().
-- We don't create a helper function in the storage schema because Supabase
-- migrations run as a role without CREATE permission on `storage` (the
-- schema is owned by supabase_storage_admin). Inlining keeps the logic in
-- public-schema-side policies that we DO own.

-- org-runs: read requires active membership in the org whose UUID is segment 2.
CREATE POLICY org_runs_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'org-runs'
    AND split_part(name, '/', 1) = 'org'
    AND EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id::text = split_part(name, '/', 2)
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

-- user-runs: only the owner can read.
CREATE POLICY user_runs_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'user-runs'
    AND split_part(name, '/', 1) = 'user'
    AND split_part(name, '/', 2) = auth.uid()::text
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
