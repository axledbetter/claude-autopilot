-- Phase 2.3 — CLI dashboard API keys + mint nonce dedup.
-- Spec: docs/specs/v7.0-phase2.3-cli-dashboard.md (PR #120).

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  prefix_display TEXT NOT NULL CHECK (prefix_display ~ '^clp_[0-9a-f]{12}$'),
  label TEXT CHECK (label IS NULL OR char_length(label) <= 100),  -- codex PR NOTE
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX api_keys_user_active ON api_keys (user_id) WHERE revoked_at IS NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY api_keys_select_own ON api_keys
  FOR SELECT USING (user_id = auth.uid());

-- Codex PR CRITICAL — un-revoke vulnerability. The earlier policy allowed
-- authed users to UPDATE any column on their own rows (column grants
-- limited it to revoked_at). But UPDATE revoked_at = NULL on a previously
-- revoked key would re-activate it. Fix: USING requires the row currently
-- be active; WITH CHECK requires the row become revoked.
CREATE POLICY api_keys_revoke_own ON api_keys
  FOR UPDATE
  USING (user_id = auth.uid() AND revoked_at IS NULL)
  WITH CHECK (user_id = auth.uid() AND revoked_at IS NOT NULL);

-- INSERT is service-role only (mint goes through /api/dashboard/api-keys/mint).
-- No INSERT policy → blocked for authed users by default.

CREATE TABLE api_key_mint_nonces (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL CHECK (nonce ~ '^[0-9a-f]{32}$'),
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, nonce)
);

CREATE INDEX api_key_mint_nonces_cleanup ON api_key_mint_nonces (created_at);

-- Codex plan-pass CRITICAL — RLS on the nonce table too. Service-role-only.
ALTER TABLE api_key_mint_nonces ENABLE ROW LEVEL SECURITY;
-- No policies → authenticated/anon get nothing; service role bypasses RLS.

-- Codex plan-pass WARNING — restrict authenticated users from reading
-- the key_hash column. Recommended pattern: revoke broad SELECT then
-- re-grant column-level access.
REVOKE ALL ON api_keys FROM authenticated, anon;
GRANT SELECT (id, prefix_display, label, created_at, last_used_at, revoked_at)
  ON api_keys TO authenticated;
GRANT UPDATE (revoked_at) ON api_keys TO authenticated;

-- Inline expiry RPC — mint endpoint calls this BEFORE checking nonce
-- uniqueness so "same nonce within 5 min" is enforced behaviorally
-- without needing a separate GC sweeper.
CREATE OR REPLACE FUNCTION expire_mint_nonces() RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.api_key_mint_nonces
      WHERE created_at < NOW() - INTERVAL '5 minutes'
      RETURNING 1
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION expire_mint_nonces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_mint_nonces() TO service_role;

-- Codex plan-pass CRITICAL — atomic mint+nonce-record in a single transaction.
-- Without this, two concurrent mint calls with the same (user, nonce) can
-- both pass the lookup, both INSERT api_keys (different rows), and only
-- one of them will succeed at INSERT api_key_mint_nonces — leaving an
-- orphaned active key from the loser.
CREATE OR REPLACE FUNCTION mint_api_key_with_nonce(
  p_user_id UUID,
  p_nonce TEXT,
  p_key_hash TEXT,
  p_prefix_display TEXT,
  p_label TEXT
) RETURNS TABLE (key_id UUID) AS $$
DECLARE
  new_id UUID;
BEGIN
  -- Sweep stale nonces first (idempotent within the txn).
  DELETE FROM public.api_key_mint_nonces
    WHERE created_at < NOW() - INTERVAL '5 minutes';

  -- Reject duplicate nonce within the window.
  IF EXISTS (
    SELECT 1 FROM public.api_key_mint_nonces
      WHERE user_id = p_user_id AND nonce = p_nonce
  ) THEN
    RAISE EXCEPTION 'nonce_conflict' USING ERRCODE = 'P0010';
  END IF;

  -- Insert key + nonce binding atomically.
  INSERT INTO public.api_keys (user_id, key_hash, prefix_display, label)
    VALUES (p_user_id, p_key_hash, p_prefix_display, p_label)
    RETURNING id INTO new_id;

  -- Codex PR WARNING — concurrent mint with same (user_id, nonce) can
  -- both pass the IF EXISTS check above. Catch the unique-violation on
  -- the nonce insert and re-raise as our typed P0010 error so the route
  -- maps it to 409 instead of 500.
  BEGIN
    INSERT INTO public.api_key_mint_nonces (user_id, nonce, api_key_id)
      VALUES (p_user_id, p_nonce, new_id);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'nonce_conflict' USING ERRCODE = 'P0010';
  END;

  RETURN QUERY SELECT new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION mint_api_key_with_nonce(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mint_api_key_with_nonce(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
