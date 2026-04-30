-- Anonymized fixture migration for the Delegance regression CI lane.
-- Creates a single throwaway table so the dispatcher → migrator path
-- has something to apply, and the _schema_migrations ledger gets a row.
CREATE TABLE IF NOT EXISTS regression_test (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
