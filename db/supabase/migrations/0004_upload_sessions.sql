-- 0004_upload_sessions.sql
-- Short-lived signed sessions for CLI event uploads.
-- We store only the JWT's jti + a hash of the token bytes — never the raw signing material.
-- Cryptographic verification happens in app code; this row just confirms the
-- session was issued + tracks single-use.

CREATE TABLE public.upload_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  jti TEXT NOT NULL UNIQUE,  -- JWT id claim, used for replay-prevention lookup
  token_hash TEXT NOT NULL,  -- SHA256 of the token bytes; never the raw token
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,  -- single-use marker — finalize sets this
  CONSTRAINT upload_sessions_consume_window CHECK (
    consumed_at IS NULL OR consumed_at <= expires_at
  )
);

CREATE INDEX upload_sessions_jti_idx ON public.upload_sessions(jti);
CREATE INDEX upload_sessions_user_run_idx ON public.upload_sessions(user_id, run_id);

ALTER TABLE public.upload_sessions ENABLE ROW LEVEL SECURITY;

-- Only the user the session was issued to can read it.
CREATE POLICY upload_sessions_select_owner ON public.upload_sessions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Inserts come from the server (service_role) — clients cannot mint sessions.
CREATE POLICY upload_sessions_no_client_insert ON public.upload_sessions
  FOR INSERT TO authenticated
  WITH CHECK (false);

-- Updates similarly server-only (the finalize endpoint sets consumed_at).
CREATE POLICY upload_sessions_no_client_update ON public.upload_sessions
  FOR UPDATE TO authenticated
  USING (false);

GRANT ALL ON public.upload_sessions TO service_role;

-- Wire the runs FK now that the target exists.
ALTER TABLE public.runs
  ADD CONSTRAINT runs_upload_session_fk
  FOREIGN KEY (upload_session_id) REFERENCES public.upload_sessions(id) ON DELETE SET NULL;
