---
name: migrate-supabase
description: Run database migrations against Supabase environments (dev → QA → prod). Validates SQL, executes with ledger tracking, and auto-generates the configured types output. Reads paths from .autopilot/stack.md (migrate.supabase.deltas_dir / types_out / envs_file).
---

# Database Migration — Supabase

Run a migration through the dev → QA → prod pipeline with validation at each step. This is the "rich" Supabase variant of the migrate skill, configured via `.autopilot/stack.md`.

All paths are parameterized — the skill reads them from stack.md instead of hardcoding repo-specific locations:

- `migrate.supabase.deltas_dir` — directory holding timestamped `.sql` delta files (e.g. `data/deltas`)
- `migrate.supabase.types_out` — generated TypeScript types output path (e.g. `types/supabase.ts`)
- `migrate.supabase.envs_file` — JSON file with per-env `dbUrl` values (e.g. `.claude/supabase-envs.json`, gitignored)

Examples below show common defaults in angle brackets. Substitute the values from your stack.md.

## Usage

### 1. Identify the migration file

If given as argument, use that. Otherwise find the most recently modified `.sql` file in the configured deltas directory (`${migrate.supabase.deltas_dir}`, e.g. `data/deltas/`).

### 2. Validate (dry run on dev)

```bash
npx tsx scripts/supabase/migrate.ts <file> --env dev --dry-run
```

Present validation results. If errors, help the user fix them before proceeding.

### 3. Run on dev

```bash
npx tsx scripts/supabase/migrate.ts <file> --env dev
```

### 4. Ask the user

> "Migration succeeded on dev. The configured types output (`${migrate.supabase.types_out}`) was updated. Promote to QA?"

### 5. Run on QA

```bash
npx tsx scripts/supabase/migrate.ts --promote qa
```

### 6. Ask the user

> "Migration succeeded on QA. Promote to prod?"

### 7. Run on prod

```bash
npx tsx scripts/supabase/migrate.ts --promote prod --confirm-prod
```

### 8. Commit

After all environments are done, commit the updated types output and the migration file:

```bash
git add ${migrate.supabase.types_out} ${migrate.supabase.deltas_dir}/<migration-file>
git commit -m "feat: <description of schema change>"
```

## Flags

| Flag | Purpose |
|------|---------|
| `--env dev\|qa\|prod` | Target environment |
| `--dry-run` | Validate only, don't execute |
| `--force` | Allow destructive operations (DROP, TRUNCATE) |
| `--confirm-prod` | Required for prod execution |
| `--promote qa\|prod` | Run missing migrations from source env |

## Validation Checks

The system validates before every execution:
- Duplicate table/column detection
- snake_case naming enforcement
- RLS + policy required for every new table
- Destructive operation blocking (unless --force)
- Cross-env prerequisite verification
- Checksum integrity (modified files are rejected)
- Promotion chain enforcement (prod requires QA first)

## Requirements

- The configured envs file (`${migrate.supabase.envs_file}`, e.g. `.claude/supabase-envs.json`) with `dbUrl` for each env (gitignored)
- `postgres` npm package installed

## Canonical result artifact (autopilot dispatcher integration)

When invoked under the autopilot pipeline (`AUTOPILOT_ENVELOPE` env var set), this skill writes a result artifact to `AUTOPILOT_RESULT_PATH` (or to nonce-bound stdout markers if `stdoutFallback: true` is set in the manifest):

```json
{
  "contractVersion": "1.0",
  "skillId": "migrate.supabase@1",
  "invocationId": "<from envelope>",
  "nonce": "<from envelope>",
  "status": "applied" | "skipped" | "validation-failed" | "needs-human" | "error",
  "reasonCode": "<short string>",
  "appliedMigrations": ["<file.sql>"],
  "destructiveDetected": false,
  "sideEffectsPerformed": ["migration-ledger-updated", "types-regenerated"],
  "nextActions": ["regenerate-types"]
}
```

Required `sideEffectsPerformed` values reserved by the contract: `types-regenerated`, `migration-ledger-updated`, `schema-cache-refreshed`, `seed-data-applied`, `snapshot-written`, `no-side-effects`.

## Stack.md configuration

```yaml
schema_version: 1
migrate:
  skill: "migrate.supabase@1"
  supabase:
    deltas_dir: "data/deltas"
    types_out: "types/supabase.ts"
    envs_file: ".claude/supabase-envs.json"
  policy:
    allow_prod_in_ci: false
```
