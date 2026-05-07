-- db/supabase/seed/test-fixtures.sql
-- Two orgs (Alice's and Bob's), each with one member, plus one shared "Eve"
-- who's a member of NEITHER (used as a cross-tenant negative actor).
-- Plus one free-tier user (Frank) who has no org.

-- Users — created via supabase.auth.admin.createUser in the test harness;
-- here we just seed the public-side data once those users exist.

-- Helper: get-or-create a test user. The test harness invokes this with the
-- IDs returned from auth.admin.createUser.

-- (Intentionally minimal — the test harness handles user creation per-test.)
