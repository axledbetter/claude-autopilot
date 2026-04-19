---
name: migrate
description: Run database migrations against Supabase environments (dev → QA → prod). Validates SQL, executes with ledger tracking, and auto-generates types/supabase.ts.
---

# Database Migration

Run a migration through the dev → QA → prod pipeline with validation at each step.

## Usage

### 1. Identify the migration file

If given as argument, use that. Otherwise find the most recently modified `.sql` file in `data/deltas/`.

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

> "Migration succeeded on dev. `types/supabase.ts` updated. Promote to QA?"

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

After all environments are done, commit the updated `types/supabase.ts` and the migration file:

```bash
git add types/supabase.ts data/deltas/<migration-file>
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

- `.claude/supabase-envs.json` with `dbUrl` for each env (gitignored)
- `postgres` npm package installed
