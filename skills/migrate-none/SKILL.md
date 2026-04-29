---
name: migrate-none
description: No-op migrate skill. Emits a skipped ResultArtifact and exits cleanly. Used when migrations are intentionally not configured (e.g., a doc-only PR, a brand-new project before any DB exists).
---

# /migrate-none — Migration intentionally not configured

The explicit "no migrations" state for the autopilot pipeline. Set `migrate.skill: "none@1"` in `.autopilot/stack.md` to short-circuit the migrate phase.

## What it does

1. Read `AUTOPILOT_ENVELOPE` for the invocationId + nonce
2. Write a ResultArtifact to `AUTOPILOT_RESULT_PATH` with:
   - `status: "skipped"`
   - `reasonCode: "migration-disabled"`
   - `appliedMigrations: []`
   - `destructiveDetected: false`
   - `sideEffectsPerformed: ["no-side-effects"]`
   - `nextActions: []`
3. Exit with code 0

That's it. The dispatcher reads the result and continues to the next pipeline phase.

## When to use

- Brand-new project with no schema yet (you don't have a DB or migration tool yet)
- Docs-only or refactor-only PRs that touch no schema
- Repos where migrations are managed entirely outside the autopilot pipeline

For everything else, use `migrate@1` (thin orchestrator) or `migrate.supabase@1` (rich Supabase runner).

## Configuration

```yaml
schema_version: 1
migrate:
  skill: "none@1"
```

No `envs` block needed.
