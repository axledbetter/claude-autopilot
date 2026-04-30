---
name: migrate-supabase
description: Fixture stub for the Delegance regression CI lane. Real Supabase migration logic is exercised through the env command (mini-migrator.mjs) which writes to the _schema_migrations ledger.
---

# migrate-supabase (regression fixture)

Stub. The actual ledger writes happen in `mini-migrator.mjs` invoked via the
`migrate.envs.dev.command` in `.autopilot/stack.md`. The dispatcher round-trip
exercises handshake → policy → executor → result-parser → audit log.
