# Migrate Skill Generalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the `migrate` skill in `@delegance/claude-autopilot` so it works for non-Supabase stacks (Prisma, Drizzle, Rails, Go, etc.) while preserving Delegance's existing rich Supabase behavior unchanged.

**Architecture:** Two-skill split — thin `migrate` orchestrator (greenfield default) + `migrate-supabase` (Delegance's runner, paths parameterized via stack.md). Pipeline dispatcher reads stack.md `migrate.skill` (versioned alias map), validates schema (AJV), runs version handshake, builds canonical invocation envelope, executes command via structured argv (no shell), parses self-describing result artifact, emits hash-chained audit log entry.

**Tech Stack:** TypeScript (existing), AJV (existing dep), Node `node:child_process` (`spawn` with `shell: false`), Node `node:test` (existing test runner), GitHub Actions.

**Source spec:** `docs/superpowers/specs/2026-04-29-migrate-skill-generalization-design.md`

**Target version:** `5.2.0`

---

## File Structure

### New files (37)

**Core types & contracts:**
- `src/core/migrate/types.ts` — Envelope, ResultArtifact, SkillManifest, AliasMap types
- `src/core/migrate/contract.ts` — Constants: contract version, result-artifact schema, marker strings
- `presets/aliases.lock.json` — Stable ID → skill path map
- `presets/schemas/migrate.schema.json` — JSON Schema for stack.md migrate block

**Dispatcher:**
- `src/core/migrate/dispatcher.ts` — Main entry: resolve → handshake → execute → parse
- `src/core/migrate/alias-resolver.ts` — Stable ID resolution + raw name normalization
- `src/core/migrate/envelope.ts` — Build invocation envelope + invocationId
- `src/core/migrate/result-parser.ts` — File-first, stdout fallback (opt-in), oversized/truncated detection
- `src/core/migrate/handshake.ts` — Skill manifest read + version compatibility check
- `src/core/migrate/executor.ts` — `spawn` with `shell: false`, env_file resolution
- `src/core/migrate/audit-log.ts` — JSONL writer with seq + prev_hash chain + flock

**Schema validation:**
- `src/core/migrate/schema-validator.ts` — Compiled AJV instance, custom `stableSkillId` keyword
- `src/core/migrate/policy-enforcer.ts` — Per-policy enforcement points (clean_git, manual_approval, dry_run_first, allow_prod_in_ci, CI provider detection)

**Detection & init:**
- `src/core/migrate/detector.ts` — Detection rules with confidence scoring
- `src/core/migrate/detector-rules.ts` — Per-stack detection rule definitions
- `src/cli/init-migrate.ts` — `init` flow extension: walk repos, score, prompt, write stack.md
- `src/core/migrate/monorepo.ts` — Workspace discovery + per-workspace dispatch

**Doctor extensions:**
- `src/core/migrate/doctor-checks.ts` — All 8 doctor checks for migrate
- `src/cli/migrate-doctor.ts` — CLI wiring

**Migration / archive:**
- `src/core/migrate/migrator.ts` — Move old `/migrate` skill → `migrate-supabase`, idempotent

**Skills:**
- `skills/migrate/SKILL.md` — Thin orchestrator instructions (LLM-readable)
- `skills/migrate/skill.manifest.json` — Manifest
- `skills/migrate-none/SKILL.md` — No-op skill
- `skills/migrate-none/skill.manifest.json`
- `skills/migrate-supabase/SKILL.md` — Will be created by Phase 5 (rename)
- `skills/migrate-supabase/skill.manifest.json`

**Tests (16 new test files):**
- `tests/migrate/types.test.ts`
- `tests/migrate/envelope.test.ts`
- `tests/migrate/result-parser.test.ts`
- `tests/migrate/dispatcher.test.ts`
- `tests/migrate/alias-resolver.test.ts`
- `tests/migrate/handshake.test.ts`
- `tests/migrate/executor.test.ts`
- `tests/migrate/audit-log.test.ts`
- `tests/migrate/schema-validator.test.ts`
- `tests/migrate/policy-enforcer.test.ts`
- `tests/migrate/detector.test.ts`
- `tests/migrate/monorepo.test.ts`
- `tests/migrate/doctor-checks.test.ts`
- `tests/integration/migrate-prisma.test.ts`
- `tests/integration/migrate-supabase.test.ts`
- `tests/integration/monorepo-mixed.test.ts`

**CI:**
- `.github/workflows/delegance-regression.yml` — Required check, runs Delegance fixture e2e

**Docs:**
- `docs/skills/version-compatibility.md` — Compatibility matrix
- `docs/skills/rich-migrate-contract.md` — Contract for future rich variants

### Modified files (6)

- `src/cli/index.ts` — Wire `migrate` dispatcher; add `init` migrate detection step
- `src/cli/init.ts` — Extend with detection + stack.md write
- `src/cli/doctor.ts` — Wire migrate-specific checks
- `skills/autopilot/SKILL.md` — Replace `/migrate` invocation with envelope-based dispatch
- `package.json` — Bump to `5.2.0`, add `shell-quote` dep
- `presets/generic/stack.md` — Update `migrate` block to new schema

---

## Phase 1: Core types & contracts

### Task 1.1: Define core migrate types

**Files:**
- Create: `src/core/migrate/types.ts`
- Test: `tests/migrate/types.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/migrate/types.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InvocationEnvelope, ResultArtifact, SkillManifest } from '../../src/core/migrate/types.ts';

describe('migrate types', () => {
  it('InvocationEnvelope has all required fields', () => {
    const env: InvocationEnvelope = {
      contractVersion: '1.0',
      invocationId: 'uuid',
      trigger: 'cli',
      attempt: 1,
      repoRoot: '/r',
      cwd: '/r',
      changedFiles: [],
      env: 'dev',
      dryRun: false,
      ci: false,
      gitBase: 'sha',
      gitHead: 'sha',
    };
    assert.equal(env.contractVersion, '1.0');
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
cd /tmp/autopilot-issues && npm test -- tests/migrate/types.test.ts
```
Expected: FAIL with "Cannot find module '../../src/core/migrate/types.ts'"

- [ ] **Step 3: Create types**

```typescript
// src/core/migrate/types.ts
export interface InvocationEnvelope {
  contractVersion: '1.0';
  invocationId: string;
  trigger: 'cli' | 'ci';
  attempt: number;
  repoRoot: string;
  cwd: string;
  changedFiles: string[];
  env: string;
  dryRun: boolean;
  ci: boolean;
  gitBase: string;
  gitHead: string;
  projectId?: string;
}

export type ResultStatus =
  | 'applied' | 'skipped' | 'validation-failed' | 'needs-human' | 'error';

export interface ResultArtifact {
  contractVersion: '1.0';
  skillId: string;
  invocationId: string;
  status: ResultStatus;
  reasonCode: string;
  appliedMigrations: string[];
  destructiveDetected: boolean;
  sideEffectsPerformed: SideEffect[];
  nextActions: string[];
}

export type SideEffect =
  | 'types-regenerated'
  | 'migration-ledger-updated'
  | 'schema-cache-refreshed'
  | 'seed-data-applied'
  | 'snapshot-written'
  | 'no-side-effects';

export interface SkillManifest {
  skillId: string;
  skill_runtime_api_version: string;
  min_runtime: string;
  max_runtime: string;
  stdoutFallback?: boolean;
}

export interface CommandSpec {
  exec: string;
  args: string[];
}

export interface AliasEntry {
  stableId: string;
  resolvesTo: string;
  rawAliases?: string[];
}
```

- [ ] **Step 4: Run test passes**

```bash
cd /tmp/autopilot-issues && npm test -- tests/migrate/types.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /tmp/autopilot-issues && git add src/core/migrate/types.ts tests/migrate/types.test.ts
git commit -m "feat(migrate): core type definitions for envelope, result, manifest"
```

### Task 1.2: Define contract constants

**Files:**
- Create: `src/core/migrate/contract.ts`

- [ ] **Step 1: Create file**

```typescript
// src/core/migrate/contract.ts
export const ENVELOPE_CONTRACT_VERSION = '1.0';
export const RESULT_ARTIFACT_MAX_BYTES = 1_048_576; // 1 MB
export const STDOUT_MARKER_PREFIX = '@@AUTOPILOT_RESULT_BEGIN:';
export const STDOUT_MARKER_SUFFIX = '@@AUTOPILOT_RESULT_END:';
export const RESERVED_SIDE_EFFECTS = [
  'types-regenerated',
  'migration-ledger-updated',
  'schema-cache-refreshed',
  'seed-data-applied',
  'snapshot-written',
  'no-side-effects',
] as const;
export const SHELL_METACHARS = /[|;&><`$()]/;
```

- [ ] **Step 2: Commit**

```bash
git add src/core/migrate/contract.ts
git commit -m "feat(migrate): contract constants (versions, limits, reserved enums)"
```

### Task 1.3: Stable ID alias map

**Files:**
- Create: `presets/aliases.lock.json`
- Test: `tests/migrate/alias-resolver.test.ts` (basic load test only here; full resolver in Phase 3)

- [ ] **Step 1: Write the alias map**

```json
{
  "schemaVersion": 1,
  "aliases": [
    { "stableId": "migrate@1", "resolvesTo": "skills/migrate/", "rawAliases": ["migrate"] },
    { "stableId": "migrate.supabase@1", "resolvesTo": "skills/migrate-supabase/", "rawAliases": ["migrate-supabase"] },
    { "stableId": "none@1", "resolvesTo": "skills/migrate-none/", "rawAliases": ["none", "skip"] }
  ]
}
```

- [ ] **Step 2: Write basic load test**

```typescript
// tests/migrate/alias-resolver.test.ts (will grow in Phase 3)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('aliases.lock.json', () => {
  it('loads valid JSON with required entries', () => {
    const aliasesPath = path.resolve(__dirname, '../../presets/aliases.lock.json');
    const data = JSON.parse(fs.readFileSync(aliasesPath, 'utf8'));
    assert.equal(data.schemaVersion, 1);
    const ids = data.aliases.map((a: { stableId: string }) => a.stableId);
    assert.ok(ids.includes('migrate@1'));
    assert.ok(ids.includes('migrate.supabase@1'));
    assert.ok(ids.includes('none@1'));
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- tests/migrate/alias-resolver.test.ts
git add presets/aliases.lock.json tests/migrate/alias-resolver.test.ts
git commit -m "feat(migrate): stable ID alias map shipping in package"
```

---

## Phase 2: Stack.md schema + AJV validation

### Task 2.1: Write JSON Schema

**Files:**
- Create: `presets/schemas/migrate.schema.json`

The schema covers two shapes via `if/then/else` on `migrate.skill`:
- `migrate@1` shape: `envs.dev.command` required, structured `{ exec, args[] }`, `policy` block
- `migrate.supabase@1` shape: `supabase.deltas_dir`, `supabase.types_out`, `supabase.envs_file` required
- `none@1` shape: minimal, just `migrate.skill`

Forbids:
- Shell metachars in `args[]` entries
- `..` or absolute paths in `env_file`
- `envs.dev.command` value identical to any non-dev `envs.*.command`

- [ ] **Steps:** Write schema, write conformance tests with valid + invalid fixtures, run, commit.

### Task 2.2: AJV validator with custom keyword

**Files:**
- Create: `src/core/migrate/schema-validator.ts`
- Test: `tests/migrate/schema-validator.test.ts`

- [ ] **Steps:**
1. Failing test: validator rejects unknown `migrate.skill`
2. Implement: load aliases.lock.json, register custom AJV keyword `stableSkillId`, compile schema once at module load, export `validateStackMd(yaml: string)` returning `{ valid, errors[] }`
3. Tests for: valid migrate@1 stack.md, valid migrate.supabase@1 stack.md, invalid stable ID rejected, shell metachar in args[] rejected, env_file with `..` rejected, dev_command-as-prod-command rejected
4. Commit

### Task 2.3: Compiled validator caching

**Files:**
- Modify: `src/core/migrate/schema-validator.ts`

- [ ] **Steps:** Wrap validator behind a memoized singleton. Test that `validateStackMd` called twice doesn't recompile (mock `ajv.compile`, assert call count == 1). Commit.

---

## Phase 3: Dispatcher (resolve → handshake → execute → parse → audit)

### Task 3.1: Alias resolver

**Files:**
- Create: `src/core/migrate/alias-resolver.ts`
- Modify: `tests/migrate/alias-resolver.test.ts`

- [ ] **Steps:**
1. Tests for: exact stable ID match, raw name auto-normalize, unknown major (`@2`) hard error, monorepo lookup precedence, multiple-candidate hard error
2. Implement `resolve(rawOrStableId: string, scope: { workspace?: string, repoRoot: string }): { stableId, skillPath, normalizedFromRaw }`
3. Run + commit

### Task 3.2: Skill manifest handshake

**Files:**
- Create: `src/core/migrate/handshake.ts`
- Test: `tests/migrate/handshake.test.ts`

- [ ] **Steps:**
1. Tests: compatible runtime (within range, matching API major) → ok; runtime below `min_runtime` → fail with upgrade message; API major mismatch → fail; missing manifest file → fail-closed
2. Implement: load `skill.manifest.json` from skill path, semver-compare against currentRuntime + currentEnvelopeContractVersion
3. Commit

### Task 3.3: Envelope builder

**Files:**
- Create: `src/core/migrate/envelope.ts`
- Test: `tests/migrate/envelope.test.ts`

- [ ] **Steps:**
1. Tests: invocationId is unique per call (UUIDv4), CI auto-detected from env vars, gitBase/gitHead read via `git rev-parse`, fail if not in a git repo
2. Implement `buildEnvelope(opts: { changedFiles, env, dryRun, ci?, projectId? })` returning `InvocationEnvelope`
3. Commit

### Task 3.4: Result parser (file-first, stdout fallback)

**Files:**
- Create: `src/core/migrate/result-parser.ts`
- Test: `tests/migrate/result-parser.test.ts`

- [ ] **Steps:**
1. Tests:
   - File-only path: writes to AUTOPILOT_RESULT_PATH, reads it, parses, validates required fields
   - Stdout fallback (opt-in): scans for delimiters bound to invocationId, ignores mismatched IDs
   - Oversized output (>1 MB) → `reasonCode: result-too-large`
   - Missing END marker → `reasonCode: result-truncated`
   - Required field missing → `reasonCode: invalid-result-artifact`
   - Unknown field with same major contractVersion → ignored (forward compat)
   - Unknown major contractVersion → hard error
   - Spoofed delimiters with wrong invocationId → ignored
2. Implement
3. Commit

### Task 3.5: Command executor

**Files:**
- Create: `src/core/migrate/executor.ts`
- Test: `tests/migrate/executor.test.ts`

- [ ] **Steps:**
1. Tests:
   - Structured argv runs successfully via `spawn` with `shell: false`
   - String form (legacy) runs through `shell-quote.parse` and emits deprecation warning
   - String form with shell metachars rejected at parse
   - env_file values loaded into spawn env, never on command line
   - Cross-platform: `exec` resolved via PATH (mocked for Windows + Linux)
2. Implement; add `shell-quote` to package.json
3. Commit

### Task 3.6: Audit log writer with hash chain

**Files:**
- Create: `src/core/migrate/audit-log.ts`
- Test: `tests/migrate/audit-log.test.ts`

- [ ] **Steps:**
1. Tests:
   - Writes JSONL line with monotonic seq
   - prev_hash matches SHA-256 of previous line; first entry has prev_hash: null
   - Concurrent writes use flock-style advisory lock (proper-lockfile package), no corruption
   - `verifyChain(file)` reports any break with line number
2. Implement (using `proper-lockfile` for advisory locking; add to deps)
3. Commit

### Task 3.7: Policy enforcer

**Files:**
- Create: `src/core/migrate/policy-enforcer.ts`
- Test: `tests/migrate/policy-enforcer.test.ts`

- [ ] **Steps:**
1. Tests for each policy:
   - `allow_prod_in_ci=false` + env=prod + CI=true → reject with 4-flag checklist
   - 4 flags satisfied + provider env detected → allow
   - 4 flags satisfied but no provider env → reject (CI provider check failed)
   - `AUTOPILOT_CI_PROVIDER=custom-ci` override → allow with audit note
   - `require_clean_git=true` + uncommitted → reject with stash hint
   - `require_manual_approval=true` + interactive → prompt y/n; reject on n
   - `require_dry_run_first=true` + no prior dry-run artifact → reject
   - `require_dry_run_first=true` + dry-run artifact at `.autopilot/dry-runs/<gitHead>-<env>.json` → allow
2. Implement
3. Commit

### Task 3.8: Main dispatcher (wires everything)

**Files:**
- Create: `src/core/migrate/dispatcher.ts`
- Test: `tests/migrate/dispatcher.test.ts`

- [ ] **Steps:**
1. End-to-end tests with mocked subprocess:
   - Happy path: stack.md → resolve → handshake ok → policy ok → execute → result file → audit log
   - Schema invalid → reject before any subprocess
   - Skill missing → fail-closed with traceable error
   - Result file missing → check stdout fallback (if enabled) → otherwise error
   - Audit log entry written for every dispatch
2. Implement: `dispatch(opts) → ResultArtifact`
3. Commit

---

## Phase 4: Thin migrate skill + migrate-none skill

### Task 4.1: Write `skills/migrate/SKILL.md`

**Files:**
- Create: `skills/migrate/SKILL.md`
- Create: `skills/migrate/skill.manifest.json`

- [ ] **Steps:**
1. SKILL.md content (LLM instructions): "Read AUTOPILOT_ENVELOPE, look up `envs.<env>.command` in stack.md, execute via the dispatcher's structured-argv contract, run `post:` hooks, write result to AUTOPILOT_RESULT_PATH."
2. skill.manifest.json: `{ skillId: "migrate@1", skill_runtime_api_version: "1.0", min_runtime: "5.2.0", max_runtime: "5.x", stdoutFallback: false }`
3. Commit

### Task 4.2: Write `skills/migrate-none/SKILL.md`

**Files:**
- Create: `skills/migrate-none/SKILL.md`
- Create: `skills/migrate-none/skill.manifest.json`

- [ ] **Steps:**
1. SKILL.md content: minimal — emit ResultArtifact `{ status: "skipped", reasonCode: "migration-disabled", appliedMigrations: [], destructiveDetected: false, sideEffectsPerformed: ["no-side-effects"], nextActions: [] }`
2. Manifest analogous to migrate@1
3. Commit

---

## Phase 5: migrate-supabase skill (rename + parameterize)

### Task 5.1: Copy current `/migrate` SKILL.md → `skills/migrate-supabase/SKILL.md`

**Files:**
- Create: `skills/migrate-supabase/SKILL.md`
- Create: `skills/migrate-supabase/skill.manifest.json`

- [ ] **Steps:**
1. Copy existing skills/migrate/SKILL.md content verbatim into skills/migrate-supabase/SKILL.md
2. Replace hardcoded paths with stack.md reads:
   - `data/deltas/<file>` → `${migrate.supabase.deltas_dir}/<file>`
   - `types/supabase.ts` → `${migrate.supabase.types_out}`
   - `.claude/supabase-envs.json` → `${migrate.supabase.envs_file}`
3. Update SKILL.md to also write the canonical ResultArtifact at end of run
4. Manifest: `{ skillId: "migrate.supabase@1", skill_runtime_api_version: "1.0", ... }`
5. Commit

### Task 5.2: Adapt `scripts/supabase/migrate.ts` to read from envelope

**Files:**
- Modify: `scripts/supabase/migrate.ts`

- [ ] **Steps:**
1. Add envelope read at startup: `const env = JSON.parse(process.env.AUTOPILOT_ENVELOPE ?? '{}')`
2. Use `env.changedFiles` and `env.env` instead of CLI args when running under autopilot
3. Write ResultArtifact to `process.env.AUTOPILOT_RESULT_PATH` at exit
4. Backward compat: when AUTOPILOT_ENVELOPE missing (manual invocation), fall back to existing CLI args
5. Tests: integration test simulating envelope-driven invocation
6. Commit

---

## Phase 6: Detection rules + init flow

### Task 6.1: Detection rules table

**Files:**
- Create: `src/core/migrate/detector-rules.ts`

- [ ] **Steps:**
1. Define rule structure: `{ name, signals: { files: string[], any?: string[][] }, confidence: 'high' | 'medium' | 'low', stack: string, defaultSkill: string, defaultCommand?: CommandSpec }`
2. Encode all rules from spec table (Supabase, Prisma, Drizzle, Rails, Go, Flyway, dbmate, Alembic, Django, Ecto, TypeORM)
3. Commit

### Task 6.2: Detector with confidence scoring

**Files:**
- Create: `src/core/migrate/detector.ts`
- Test: `tests/migrate/detector.test.ts`

- [ ] **Steps:**
1. Tests with fixture repos for each rule (under `tests/fixtures/init/`):
   - Single high-confidence match → returns 1 result
   - Multiple matches with one high → returns 1 (high wins) but with `prompt: true`
   - Multiple low/medium → returns multiple, `prompt: true`
   - Zero matches → returns empty, `prompt: false`
2. Implement `detect(projectRoot: string): { matches: DetectionMatch[], prompt: boolean }`
3. Commit

### Task 6.3: Monorepo workspace discovery

**Files:**
- Create: `src/core/migrate/monorepo.ts`
- Test: `tests/migrate/monorepo.test.ts`

- [ ] **Steps:**
1. Tests: discovers from `pnpm-workspace.yaml`, `package.json#workspaces`, `nx.json`; falls back to repo root if none
2. Implement `findWorkspaces(repoRoot): string[]`
3. Commit

### Task 6.4: `init` flow extension

**Files:**
- Create: `src/cli/init-migrate.ts`
- Modify: `src/cli/init.ts`

- [ ] **Steps:**
1. After existing `init` logic, walk workspaces, run detector per workspace
2. Single high-confidence match → write stack.md non-interactively
3. Multiple/low-confidence → present chooser UI (terminal prompt with confidence badges)
4. Zero matches → exit non-zero with `--skip-migrate` hint, OR `--skip-migrate` flag → write `migrate.skill: "none@1"` stack.md
5. After write, run `claude-autopilot doctor` and report warnings
6. Tests for the full flow with mocked TTY
7. Commit

### Task 6.5: `--force-rewrite` for idempotent re-run

**Files:**
- Modify: `src/cli/init-migrate.ts`

- [ ] **Steps:**
1. Default: preserve user-edited fields, update only `detected_at`, `schema_version`, defaults
2. `--force-rewrite`: regenerate from scratch, print diff first, prompt for confirmation
3. Tests: re-run preserves custom commands; `--force-rewrite` overwrites with diff
4. Commit

---

## Phase 7: Doctor command extensions

### Task 7.1: Doctor checks for migrate

**Files:**
- Create: `src/core/migrate/doctor-checks.ts`
- Test: `tests/migrate/doctor-checks.test.ts`

- [ ] **Steps:**
1. Tests for each of 8 checks (spec § doctor):
   - stack.md exists
   - schema validates
   - skill resolves
   - per-env commands explicit
   - policy fields valid
   - project_root has expected toolchain files
   - deprecated keys reported (read-only)
   - env_file safety
2. Implement each check returning `{ ok, message?, fixHint? }`
3. Commit

### Task 7.2: Wire doctor + `--fix`

**Files:**
- Create: `src/cli/migrate-doctor.ts`
- Modify: `src/cli/doctor.ts`

- [ ] **Steps:**
1. Read-only mode: report all check failures with diffs, exit non-zero if any
2. `--fix` mode: apply auto-fixable issues (alias normalization, deprecated key migration, missing default policy)
3. Tests: golden-file diff after `doctor` (no writes); `doctor --fix` writes expected stack.md
4. Commit

---

## Phase 8: Migration / archive of old skill

### Task 8.1: Migrator (archive old `/migrate` → `migrate-supabase`)

**Files:**
- Create: `src/core/migrate/migrator.ts`

- [ ] **Steps:**
1. Detect: does `skills/migrate/` already exist with content matching the legacy Delegance shape?
2. If clean (no local diffs): `git mv skills/migrate/ skills/migrate-supabase-archive/`, then write fresh `skills/migrate/` (thin) and `skills/migrate-supabase/`
3. If user-edited: write `skills/migrate.backup-<ISO>/`, copy reference content, emit migration report
4. Idempotent: re-run is no-op if already migrated
5. Tests with all 3 scenarios (clean, edited, already-migrated)
6. Commit

### Task 8.2: Wire migrator into `doctor --fix`

**Files:**
- Modify: `src/cli/migrate-doctor.ts`

- [ ] **Steps:**
1. When old `/migrate` skill detected → migrator runs
2. Migration report written to `.autopilot/migration-report-<ISO>.md`
3. Tests
4. Commit

---

## Phase 9: Integration tests + Delegance regression CI lane

### Task 9.1: Prisma integration test

**Files:**
- Create: `tests/integration/migrate-prisma.test.ts`
- Create: `tests/fixtures/integration/prisma-fixture/` (skeleton repo)

- [ ] **Steps:**
1. Fixture: minimal Next.js + Prisma repo with sqlite, one migration
2. Test: `init` writes correct stack.md; `dispatch({env: 'dev'})` runs `prisma migrate dev`; ResultArtifact has `appliedMigrations: ['<file>']` and `sideEffectsPerformed: ['types-regenerated']`
3. Commit

### Task 9.2: Supabase integration test

**Files:**
- Create: `tests/integration/migrate-supabase.test.ts`
- Create: `tests/fixtures/integration/supabase-fixture/` (anonymized)

- [ ] **Steps:**
1. Fixture: data/deltas/, .claude/supabase-envs.json, ephemeral postgres
2. Test: `dispatch({env: 'dev'})` runs the rich migrator, ledger row appears, types/supabase.ts written, ResultArtifact populated
3. Commit

### Task 9.3: Monorepo mixed-skill test

**Files:**
- Create: `tests/integration/monorepo-mixed.test.ts`
- Create: `tests/fixtures/integration/monorepo-fixture/`

- [ ] **Steps:**
1. Fixture: pnpm workspace with `packages/web` (Prisma) + `packages/api` (Drizzle)
2. Test: `init` writes per-workspace stack.md + root manifest; dispatch in each workspace uses correct skill; audit trace shows resolution per workspace
3. Commit

### Task 9.4: Delegance regression CI lane

**Files:**
- Create: `.github/workflows/delegance-regression.yml`
- Create: `tests/fixtures/delegance-regression/` (anonymized Supabase fixture)

- [ ] **Steps:**
1. GitHub Actions workflow: spin up postgres service, run `init → doctor → migrate-supabase` against fixture, assert ledger entries match expected snapshot byte-for-byte
2. Add as required check
3. Commit

---

## Phase 10: Wire into autopilot pipeline + docs + version bump

### Task 10.1: Update `autopilot/SKILL.md`

**Files:**
- Modify: `skills/autopilot/SKILL.md`

- [ ] **Steps:**
1. Replace "run `/migrate`" with: "build envelope from current git state, dispatch via stack.md `migrate.skill`, parse result, branch on `nextActions` (e.g., regenerate-types → run typecheck)"
2. Document 4 CI prod flags
3. Reference stack.md schema doc + version compatibility doc
4. Commit

### Task 10.2: Wire CLI surface

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Steps:**
1. `claude-autopilot migrate [--env <name>] [--dry-run]` → calls `dispatch()`
2. `claude-autopilot migrate doctor` → migrate-specific doctor
3. Commit

### Task 10.3: Docs

**Files:**
- Create: `docs/skills/version-compatibility.md`
- Create: `docs/skills/rich-migrate-contract.md`
- Modify: `README.md`

- [ ] **Steps:**
1. version-compatibility.md: matrix of envelope contract versions × runtime versions × skill API versions
2. rich-migrate-contract.md: input envelope, output result artifact, exit code semantics
3. README: brief "Migration phase" subsection in pipeline overview
4. Commit

### Task 10.4: Version bump + CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Steps:**
1. Bump version to `5.2.0`
2. Add CHANGELOG entry: feature, breaking-change-status (none), upgrade-path (`doctor --fix`)
3. Commit

---

## Self-Review

**Spec coverage check:** Each spec section maps to phase(s):
- Architecture overview → Phases 1, 3, 4, 5
- Canonical envelope → Task 3.3
- Result artifact → Task 3.4
- Skill manifest + handshake → Task 3.2
- Stable skill ID alias map → Task 1.3, 3.1
- Dispatcher env safety floor → Task 3.7
- Audit log → Task 3.6
- Stack.md schema → Phase 2
- Command execution contract → Task 3.5
- Per-policy enforcement → Task 3.7
- Init & detection → Phase 6
- Doctor → Phase 7
- Backward compat → Phase 8
- Test plan → Phase 9
- Acceptance criteria → all phases

**Placeholder scan:** No "TBD"/"TODO"/"implement later" in plan. Code blocks shown for non-obvious work.

**Type consistency:** Method names match across phases (`dispatch`, `resolve`, `validateStackMd`, `buildEnvelope`, `verifyChain`).

---

## Acceptance criteria (spec § acceptance)

- [ ] All 618 existing tests pass + ~90 new tests across phases
- [ ] Plain `doctor` never writes (golden-file-diff verified)
- [ ] Skill handshake fails closed on version mismatch
- [ ] Delegance regression CI lane green
- [ ] Greenfield Next.js+Prisma fixture: `init && brainstorm` runs full pipeline including `prisma migrate dev`
- [ ] Bin smoke matrix (Mac/Linux/Windows × Node 22/24) green
- [ ] Alias snapshot integrity tests green
- [ ] Audit log emitted with stable schema + chain validates
