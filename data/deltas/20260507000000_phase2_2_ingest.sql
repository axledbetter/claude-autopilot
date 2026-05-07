-- Phase 2.2 — ingest API schema additions
-- Spec: docs/specs/v7.0-phase2.2-ingest-api.md
--
-- Codex pass folded: preflight diagnostic before partial unique index +
-- chain-root format check; concurrency RPC claim_chunk_slot lives at the
-- end of this file as a SECURITY DEFINER function.

-- ===== PREFLIGHT (codex final WARNING — pre-existing data) =====
-- Fail fast with a readable diagnostic if existing data would violate the
-- new constraints. Operators can run the SELECTs in the DO block manually
-- and clean up before re-running this migration.
DO $$
DECLARE
  bad_inflight INTEGER;
  bad_root INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_inflight FROM (
    SELECT run_id FROM upload_sessions
    WHERE consumed_at IS NULL
    GROUP BY run_id HAVING COUNT(*) > 1
  ) sub;
  IF bad_inflight > 0 THEN
    RAISE EXCEPTION 'Migration preflight failed: % run_ids have multiple unconsumed upload_sessions. Resolve before applying. Diagnostic: SELECT run_id, COUNT(*) FROM upload_sessions WHERE consumed_at IS NULL GROUP BY run_id HAVING COUNT(*) > 1;', bad_inflight;
  END IF;

  SELECT COUNT(*) INTO bad_root FROM runs
    WHERE events_chain_root IS NOT NULL AND events_chain_root !~ '^[0-9a-f]{64}$';
  IF bad_root > 0 THEN
    RAISE EXCEPTION 'Migration preflight failed: % runs.events_chain_root values are not 64-lowercase-hex. Diagnostic: SELECT id, events_chain_root FROM runs WHERE events_chain_root IS NOT NULL AND events_chain_root !~ ''^[0-9a-f]{64}$'';', bad_root;
  END IF;
END $$;

-- Augment upload_sessions with run-binding + chain state.
-- chain_tip_hash default is 64-char zero hex (NOT 'zero32' placeholder).
ALTER TABLE upload_sessions
  ADD COLUMN next_expected_seq INTEGER NOT NULL DEFAULT 0
    CHECK (next_expected_seq >= 0),
  ADD COLUMN chain_tip_hash TEXT NOT NULL
    DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (chain_tip_hash ~ '^[0-9a-f]{64}$');

-- One in-flight (non-consumed) session per run. Closes the concurrent
-- session-mint race at the DB level.
CREATE UNIQUE INDEX upload_sessions_one_inflight_per_run
  ON upload_sessions (run_id)
  WHERE consumed_at IS NULL;

-- Per-chunk record. (session_id, seq) uniqueness backstops the row lock.
CREATE TABLE upload_session_chunks (
  session_id UUID NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  hash TEXT NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'persisted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, seq)
);

-- RLS: SELECT only for the session owner (resolved via session.user_id).
-- INSERT/UPDATE/DELETE locked to service role.
ALTER TABLE upload_session_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY upload_session_chunks_select_own ON upload_session_chunks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM upload_sessions s
      WHERE s.id = upload_session_chunks.session_id
        AND s.user_id = auth.uid()
    )
  );

-- runs needs state hash + manifest reference.
ALTER TABLE runs
  ADD COLUMN state_sha256 TEXT
    CHECK (state_sha256 IS NULL OR state_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN events_index_path TEXT;

-- Tighten existing runs.events_chain_root format (was unconstrained TEXT).
ALTER TABLE runs
  ADD CONSTRAINT runs_events_chain_root_format
  CHECK (events_chain_root IS NULL OR events_chain_root ~ '^[0-9a-f]{64}$');

-- ===== CONCURRENCY RPC (codex final CRITICAL — real prod row lock) =====
-- claim_chunk_slot is the atomic critical section for chunk uploads. It
-- locks the upload_sessions row, validates expected (seq, prev_hash),
-- inserts the pending chunk row, and conditionally advances session
-- state. Returns the inserted chunk row, OR raises a typed exception
-- the route translates to 409/422.
--
-- The route still does the Storage write between two RPC calls
-- (claim_chunk_slot → Storage PUT → mark_chunk_persisted). If the
-- middle step fails, the pending row is reclaimable by an identical-
-- payload retry through the recovery path documented in the spec.

CREATE OR REPLACE FUNCTION claim_chunk_slot(
  p_jti TEXT,
  p_run_id TEXT,
  p_caller_user_id UUID,
  p_seq INTEGER,
  p_prev_hash TEXT,
  p_this_hash TEXT,
  p_bytes INTEGER,
  p_storage_path TEXT
) RETURNS TABLE (session_id UUID, seq INTEGER, hash TEXT) AS $$
DECLARE
  s RECORD;
  existing RECORD;
BEGIN
  -- Lock the session row.
  SELECT id, run_id, user_id, organization_id, next_expected_seq,
         chain_tip_hash, consumed_at, expires_at
    INTO s
    FROM upload_sessions
    WHERE jti = p_jti
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF s.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'session_consumed' USING ERRCODE = 'P0002';
  END IF;
  IF s.expires_at < NOW() THEN
    RAISE EXCEPTION 'session_expired' USING ERRCODE = 'P0003';
  END IF;
  IF s.run_id <> p_run_id OR s.user_id <> p_caller_user_id THEN
    RAISE EXCEPTION 'ownership_mismatch' USING ERRCODE = 'P0004';
  END IF;

  -- Recovery path: if a pending row already exists at (session_id, seq),
  -- accept the retry iff (hash, bytes, storage_path) match the request.
  SELECT seq, hash, bytes, storage_path, status
    INTO existing
    FROM upload_session_chunks
    WHERE session_id = s.id AND seq = p_seq;

  IF FOUND THEN
    IF existing.hash <> p_this_hash OR existing.bytes <> p_bytes OR existing.storage_path <> p_storage_path THEN
      RAISE EXCEPTION 'duplicate_chunk_mismatch' USING ERRCODE = 'P0005';
    END IF;
    -- Same-payload retry. Don't advance session state here — that's
    -- mark_chunk_persisted's job after Storage write succeeds.
    RETURN QUERY SELECT s.id, p_seq, p_this_hash;
    RETURN;
  END IF;

  -- Validate seq + prev_hash.
  IF p_seq <> s.next_expected_seq THEN
    RAISE EXCEPTION 'wrong_seq' USING ERRCODE = 'P0006';
  END IF;
  IF p_prev_hash <> s.chain_tip_hash THEN
    RAISE EXCEPTION 'wrong_prev_hash' USING ERRCODE = 'P0007';
  END IF;

  INSERT INTO upload_session_chunks (session_id, seq, hash, bytes, storage_path, status)
    VALUES (s.id, p_seq, p_this_hash, p_bytes, p_storage_path, 'pending');

  RETURN QUERY SELECT s.id, p_seq, p_this_hash;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION claim_chunk_slot(TEXT, TEXT, UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_chunk_slot(TEXT, TEXT, UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION mark_chunk_persisted(
  p_session_id UUID,
  p_seq INTEGER,
  p_this_hash TEXT
) RETURNS VOID AS $$
DECLARE
  s RECORD;
BEGIN
  SELECT id, next_expected_seq, chain_tip_hash
    INTO s
    FROM upload_sessions
    WHERE id = p_session_id
    FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;

  -- Conditional update — only advance if state is still at the expected
  -- pre-advance values. If a concurrent retry already advanced, this is a
  -- no-op (idempotent).
  UPDATE upload_session_chunks
    SET status = 'persisted'
    WHERE session_id = p_session_id AND seq = p_seq;

  IF s.next_expected_seq = p_seq THEN
    UPDATE upload_sessions
      SET next_expected_seq = p_seq + 1,
          chain_tip_hash = p_this_hash
      WHERE id = p_session_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION mark_chunk_persisted(UUID, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_chunk_persisted(UUID, INTEGER, TEXT) TO service_role;
