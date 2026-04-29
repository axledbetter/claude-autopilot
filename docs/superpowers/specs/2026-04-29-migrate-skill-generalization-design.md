# Migrate Skill Generalization — Design

**Date:** 2026-04-29
**Status:** Spec — pending plan + implementation
**Target version:** `@delegance/claude-autopilot@5.2.0`

## Problem

The `migrate` skill in `@delegance/claude-autopilot` is hardcoded for Supabase: it invokes `scripts/supabase/migrate.ts` with a dev → qa → prod ladder, ledger table (`_schema_migrations`), Postgres advisory locks, checksum integrity, snake_case + RLS validation, and Supabase-specific type generation. This blocks adoption for non-Supabase users (Prisma+Postgres, Drizzle, Rails, Go, etc.), who hit a wall when the autopilot pipeline reaches the migrate phase.

## Goals

- Greenfield user can run `claude-autopilot init && claude-autopilot brainstorm "<feature>"` on a Next.js+Postgres+Prisma repo and have the migrate phase work without manual config.
- Delegance's existing Supabase setup keeps working byte-for-byte (no behavior regression).
- Adding new migration tools (Drizzle, Flyway, etc.) requires a preset + detection rule, not a code change in core.
- Production migration commands cannot be triggered accidentally.
- Stack.md is the single source of truth for which migration skill to invoke; runtime never silently re-detects.

## Non-goals (deferred to v1.1+)

- "Keep both" multi-tool option (e.g., Supabase primary + Prisma post-step) — too much footgun risk to ship in v1
- Second-tier detectors beyond Alembic / Django / Ecto / TypeORM (Liquibase, Atlas, Knex, Sequelize, Sqitch, sqlx, sqitch)
- Capability manifest declaring per-skill validate/test phase support
- URI-style canonical IDs (`autopilot:migrate/supabase@1`); the dotted form is enough for v1

## Architecture overview

### Two skills (preserves Delegance's rich behavior, ships a thin default)

- **`skills/migrate/SKILL.md`** — thin orchestrator. Greenfield default. Reads `stack.md`, runs `envs.<env>.command` for the requested env, runs `post:` hooks, writes a result artifact.
- **`skills/migrate-supabase/SKILL.md`** — rich runner. Today's `migrate` SKILL.md content, copied verbatim. Calls `scripts/supabase/migrate.ts` with paths now parameterized via stack.md (`migrate.supabase.deltas_dir`, `migrate.supabase.types_out`, `migrate.supabase.envs_file`). Delegance's `.autopilot/stack.md` pins these to current values.

### Canonical invocation envelope (dispatcher → skill)

Passed via env vars (`AUTOPILOT_ENVELOPE`, `AUTOPILOT_RESULT_PATH`) and stdin JSON:

```json
{
  "contractVersion": "1.0",
  "invocationId": "<uuid>",
  "trigger": "cli" | "ci",
  "attempt": 1,
  "repoRoot": "/abs/path",
  "cwd": "/abs/path",
  "changedFiles": ["path/to/migration.sql"],
  "env": "dev",
  "dryRun": false,
  "ci": false,
  "gitBase": "<sha>",
  "gitHead": "<sha>",
  "projectId": "optional-monorepo-package-id"
}
```

### Result artifact (skill → dispatcher)

**Primary transport:** dispatcher passes `AUTOPILOT_RESULT_PATH=/tmp/<uuid>.json`; skill writes JSON there.
**Fallback transport:** delimited stdout markers `@@AUTOPILOT_RESULT_BEGIN@@\n{...}\n@@AUTOPILOT_RESULT_END@@` for environments where the env var is stripped.
Pipeline reads the file first, falls back to delimiter scan, errors on neither.

```json
{
  "contractVersion": "1.0",
  "skillId": "migrate.supabase@1",
  "invocationId": "<echoes envelope>",
  "status": "applied" | "skipped" | "validation-failed" | "needs-human" | "error",
  "reasonCode": "<string-enum>",
  "appliedMigrations": ["20260429_add_status.sql"],
  "destructiveDetected": false,
  "sideEffectsPerformed": ["types-regenerated"],
  "nextActions": ["regenerate-types"]
}
```

**Reserved `sideEffectsPerformed` vocabulary (v1):** `types-regenerated`, `migration-ledger-updated`, `schema-cache-refreshed`, `seed-data-applied`, `snapshot-written`, `no-side-effects`. Skills cannot invent new values; new entries land via package release.

**Parser policy:**
- Required fields missing → `status: error, reasonCode: invalid-result-artifact`
- Unknown fields ignored for minor version upgrades
- Unknown major contract version → hard error, suggests `claude-autopilot doctor`
- Output > 1 MB → `reasonCode: result-too-large`
- Truncated output (missing END marker) → `reasonCode: result-truncated`

### Skill manifest + version handshake

Each skill ships `skills/<name>/skill.manifest.json`:

```json
{
  "skillId": "migrate.supabase@1",
  "skill_api_version": "1.0",
  "min_runtime": "5.2.0",
  "max_runtime": "5.x"
}
```

Dispatcher reads the manifest before invoking. If `runtime ∉ [min, max]` or `skill_api_version` major doesn't match runtime contract version → fail-closed with explicit upgrade instructions.

### Stable skill ID alias map

`presets/aliases.lock.json` ships with the package and pins resolution at install time:

| Stable ID | Resolves to |
|---|---|
| `migrate@1` | `skills/migrate/` |
| `migrate.supabase@1` | `skills/migrate-supabase/` |

**Resolution rules:**
- Exact stable ID match (`migrate@1`) wins
- Raw skill name (e.g. `"migrate-supabase"`) is auto-normalized to its stable ID via `doctor --fix` (warns plain `doctor`)
- Unknown major version (`@2` when registry only has `@1`) → hard error, suggests `claude-autopilot doctor`
- Multiple raw-name candidates in active scope → hard error listing them; user must use exact stable ID
- Monorepo lookup: workspace `.autopilot/` → repo root `.autopilot/` → globally installed

### Dispatcher-level env safety floor (skills cannot relax)

For non-dev envs:
- Interactive runs require explicit confirmation prompt
- Non-interactive (CI) runs require **all four** of: `--yes` flag, `AUTOPILOT_CI_POLICY=allow-prod` env, `AUTOPILOT_TARGET_ENV=prod` env (must equal `--env`), and `migrate.policy.allow_prod_in_ci: true` in stack.md
- Plus provider-env detection (`GITHUB_ACTIONS=true` / `CI=true` / etc.) — local shells with the env vars manually set don't trigger; only real CI does

Stack.md schema **forbids** `envs.dev.command` value appearing as any non-dev env's command (prevents `prisma migrate dev` against prod).

### Audit log

Every dispatch emits one event to `.autopilot/audit.log` (JSONL):

```json
{
  "ts": "2026-04-29T...",
  "invocationId": "uuid",
  "event": "dispatch",
  "requested_skill": "migrate@1",
  "resolved_skill": "migrate.supabase@1",
  "skill_path": "skills/migrate-supabase/SKILL.md",
  "contract_version": "1.0",
  "envelope_hash": "sha256",
  "policy_decisions": ["allow_prod_in_ci=false"],
  "mode": "apply" | "dry-run" | "doctor-fix",
  "actor": "<git user.email>",
  "ci_provider": "github-actions" | null,
  "ci_run_id": "..." | null,
  "result_status": "applied",
  "duration_ms": 3421
}
```

## Stack.md schema

```yaml
schema_version: 1
migrate:
  skill: "migrate@1"                  # default; exact stable ID
  envs:
    dev:
      command: "prisma migrate dev --skip-seed"
    staging:
      command: "prisma migrate deploy"
      env_file: ".env.staging"
    prod:
      command: "prisma migrate deploy"
      env_file: ".env.prod"
  post:
    - command: "prisma generate"
  policy:
    allow_prod_in_ci: false
    require_clean_git: true
    require_manual_approval: true
    require_dry_run_first: false
  detected_at: "2026-04-29T..."
  project_root: "."

# When migrate.skill = "migrate.supabase@1":
migrate:
  skill: "migrate.supabase@1"
  supabase:
    deltas_dir: "data/deltas"
    types_out: "types/supabase.ts"
    envs_file: ".claude/supabase-envs.json"
  policy:
    allow_prod_in_ci: false
```

**Validation:**
- JSON Schema at `presets/schemas/migrate.schema.json`, validated via existing `ajv` dep
- Discriminator via AJV `if/then/else` on `migrate.skill`; stable-ID membership via custom AJV keyword `stableSkillId` for single-pass diagnostics
- AJV validator compiled at process start, reused per dispatch
- `dev_command` (top-level) is a deprecated alias only, auto-migrated by `doctor --fix`
- Mixed usage (`dev_command` + `envs.dev`) is a hard error
- `env_file` paths must be relative to `project_root`; absolute paths and `..` rejected at schema validation
- `doctor` warns if `env_file` is git-tracked

## Init & detection

### Detection model: confidence-scored, deterministic

Each rule has explicit confidence. Single high-confidence match → auto-write. Otherwise prompt. **No "first match wins."**

| Signal | Stack | Confidence | Default `migrate.skill` |
|---|---|---|---|
| `data/deltas/` + `.claude/supabase-envs.json` | nextjs-supabase | high | `migrate.supabase@1` |
| `supabase/migrations/` | supabase-cli | high | `migrate@1` (`supabase migration up`) |
| `prisma/schema.prisma` + `prisma/migrations/` | prisma-migrate | high | `migrate@1` (`prisma migrate dev`) |
| `prisma/schema.prisma` (no migrations) | prisma-push | low | prompt — push or migrate? |
| `drizzle.config.*` + `drizzle/migrations/` | drizzle-migrate | high | `migrate@1` (`drizzle-kit migrate`) |
| `drizzle.config.*` (no migrations) | drizzle-push | low | prompt |
| `db/migrate/` + `Gemfile` with rails | rails | high | `migrate@1` (`rails db:migrate`) |
| Go module + `migrate/` | golang-migrate | high | `migrate@1` |
| `flyway.{conf,toml}` | flyway | high | `migrate@1` |
| `dbmate/` | dbmate | high | `migrate@1` |
| `alembic.ini` | alembic | medium | prompt |
| `manage.py` + `*/migrations/0001_*.py` | django | medium | prompt |
| `mix.exs` + `priv/repo/migrations/` | ecto | medium | prompt |
| TypeORM (`ormconfig.*` or `data-source.ts`) | typeorm | medium | prompt |
| `supabase/` alone (no migrations dir) | low-confidence | low | prompt |
| nothing matched | (none) | — | fail-closed |

### Init flow

```
1. Walk repo from cwd, find candidate project roots (workspaces or repo root)
2. For each root, score all detection rules; collect matches
3. Per root:
   - 1 match @ high confidence → auto-write stack.md
   - >1 match OR any non-high → prompt user (chooser UI)
   - 0 matches → fail with --skip-migrate hint
4. Run claude-autopilot doctor on the result; report warnings
```

### Zero-match: fail closed
- Default: `init` exits non-zero with "no migration tool detected; pick one or pass `--skip-migrate`"
- `--skip-migrate` writes a stack.md with `migrate: { skill: "migrate@1", envs: {} }` and a TODO comment
- No silent no-op auto-write

### Idempotent re-run (default)
- `init` preserves user-edited fields
- Updates only generated metadata (`detected_at`, `schema_version`, missing optional defaults)
- `--force-rewrite` flag regenerates from scratch with diff preview

### Monorepo handling
- Per-workspace `<workspace>/.autopilot/stack.md` — workspace overrides root defaults
- Root `.autopilot/manifest.yaml` lists workspaces + optional `execution_order`
- Pipeline reads root manifest first; runs migrate phase per workspace in declared order

## `claude-autopilot doctor`

**Plain `doctor` is strictly read-only.** Never writes to stack.md, never archives skills, never auto-normalizes. Reports a deterministic diff, exits non-zero on any required mutation.

**Only `doctor --fix` writes anything.** Schema fixups, alias normalization, Delegance auto-bootstrap, archive of old `/migrate` skill — all gated behind `--fix`.

### Checks

1. `.autopilot/stack.md` exists
2. JSON Schema validates
3. `migrate.skill` resolves to an installed skill (against alias snapshot)
4. Per-env commands explicit (no implicit `envs.dev.command` reuse)
5. `policy.*` fields match user's CI provider context
6. `project_root` exists AND has expected toolchain files for the resolved skill (`prisma/schema.prisma` for Prisma, `data/deltas/` for Supabase, etc.)
7. Deprecated keys (`dev_command`) detected → reports diff, exits non-zero, no automatic rewrite
8. `env_file` safety: relative to project_root, no `..`, not git-tracked

### Failure modes table

| Scenario | Behavior |
|---|---|
| stack.md missing | Clear error → run `init` |
| Schema fails | Reject with field path; suggest `doctor --fix` |
| `migrate.skill` unknown | Hard error, list known stable IDs |
| Env command equals `envs.dev.command` | Reject with foot-gun explanation |
| `project_root` doesn't exist | Reject; suggest `init` |
| Prod without all 4 CI flags | Reject with checklist of missing flags |
| Skill version incompatible | Reject with required version + upgrade hint |
| `project_root` lacks toolchain files | Reject with what's missing for the skill |

## Backward compat & upgrade path

### Delegance backward compat
- Existing `/migrate` skill content moves to `skills/migrate-supabase/SKILL.md` verbatim
- Delegance's `.autopilot/stack.md` is auto-bootstrapped on `doctor --fix` post-upgrade
- Existing `scripts/supabase/migrate.ts` unchanged
- Behavior identical, just invoked via the new dispatcher

### Existing autopilot installs
1. New package version 5.2.0 (minor — additive, no automatic mutation on upgrade)
2. On `doctor` post-upgrade, detect old `/migrate` skill path → report required migration → exit non-zero
3. `doctor --fix` writes new stack.md, archives old `/migrate` skill (idempotent: detect local diffs, write timestamped backup, never destructive delete; require `--force` for overwrite)
4. Migration report shipped to stdout + written to `.autopilot/migration-report-<ISO>.md`
5. Resolution trace shows `requested: migrate, resolved: migrate.supabase@1, skill_path: skills/migrate-supabase/`

### `autopilot/SKILL.md` changes
- Replaces "run /migrate" with "build envelope, dispatch via stack.md migrate.skill, parse result, act on nextActions"
- Documents the 4 CI prod flags
- References the stack.md schema doc

## Test plan

**Unit tests (Jest/node:test):**
- `tests/init/detection-*.test.ts` — fixture repos for each rule
- `tests/migrate/envelope.test.ts` — envelope construction, invocationId uniqueness
- `tests/migrate/result-parser.test.ts` — file path + delimiter fallback + missing/unknown fields + oversized + truncated
- `tests/migrate/dispatch.test.ts` — alias resolution, fail-closed on missing skill, monorepo precedence
- `tests/migrate/safety.test.ts` — env_file path traversal, dev_command-as-prod
- `tests/migrate/policy.test.ts` — 4-flag CI prod gate, audit log emission
- `tests/migrate/skill-handshake.test.ts` — version compat matrix, fail-closed on mismatch

**Security tests:**
- `tests/security/alias-snapshot-integrity.test.ts` — signed snapshot verification, checksum mismatch fail-closed, replay rejection, downgrade refusal
- `tests/security/result-artifact-parser.test.ts` — oversized output, truncated output, multi-chunk boundary

**Integration tests (real `git`, real subprocess):**
- `tests/integration/migrate-prisma.test.ts` — prisma fixture; init → /migrate → migration applied to sqlite
- `tests/integration/migrate-supabase.test.ts` — data/deltas/ fixture; init → /migrate-supabase → ledger updated
- `tests/integration/doctor.test.ts` — every doctor check, with broken fixture
- `tests/integration/monorepo-mixed.test.ts` — root + packages/web (Prisma) + packages/api (Drizzle); per-workspace dispatch + audit trace

**Snapshot tests (autoregress):**
- Detection output for each fixture repo
- Resolution trace JSON shape
- Audit log event schema

**CI:**
- New required job `.github/workflows/delegance-regression.yml` — runs full Delegance Supabase fixture (anonymized) end-to-end, asserts ledger entries identical pre/post dispatcher

## Acceptance criteria

- [ ] All 618 existing tests pass
- [ ] New detection tests cover all high-confidence rules
- [ ] Plain `doctor` never writes to disk (golden-file-diff after invocation)
- [ ] Skill handshake fails closed on version mismatch
- [ ] Delegance regression CI lane green
- [ ] Greenfield Next.js+Postgres+Prisma: `claude-autopilot init && claude-autopilot brainstorm "<feature>"` runs full pipeline including `prisma migrate dev`
- [ ] Bin smoke matrix (Mac/Linux/Windows × Node 22/24) green
- [ ] Alias snapshot integrity tests green
- [ ] Audit log emitted for every dispatch with stable schema

## Out of scope (deferred)

- "Keep both" multi-tool option (Supabase + Prisma in same project)
- Liquibase, Atlas, Knex, Sequelize, Sqitch, sqlx detectors
- Per-skill capability manifest declaring validate/test phase support
- URI-style canonical IDs

## Key risks accepted

- **Stack.md ergonomics:** users editing stack.md by hand will hit schema validation errors. Mitigated by clear field-path error messages and `doctor --fix`.
- **Detection coverage:** some users will fall in the "medium confidence" prompt path on first run. This is intentional — better than wrong default.
- **Monorepo resolution:** workspace > root > global precedence is documented but unfamiliar to most users. Mitigated by `doctor` reporting which scope resolved each ID.
