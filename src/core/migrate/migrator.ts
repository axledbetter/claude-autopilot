// src/core/migrate/migrator.ts
//
// Task 8.1 — Legacy `/migrate` skill migrator.
//
// Migrates a repo where `skills/migrate/SKILL.md` still holds the original
// Delegance Supabase-shaped content over to the generalised post-Phase-8
// layout:
//
//   skills/migrate/SKILL.md           — thin generic orchestrator (this file
//                                       describes the dispatcher contract)
//   skills/migrate-supabase/SKILL.md  — rich Supabase runner (already shipped)
//
// Detection rules (legacy shape):
//   1. SKILL.md content sha256 matches the known legacy fingerprint, OR
//   2. Frontmatter `description:` contains "Supabase" (case-insensitive)
//      AND `name:` is "migrate" (i.e. the slot is the generic skill but the
//      content describes the rich Supabase variant).
//
// Outcomes:
//   - "clean"          — content matches legacy fingerprint exactly. The
//                        legacy file is moved to a timestamped archive
//                        directory: skills/migrate.archive-<ISO>/SKILL.md.
//                        Then the thin reference is written to
//                        skills/migrate/SKILL.md.
//   - "user-edited"    — description matches but content drifted. We write
//                        a backup at skills/migrate.backup-<ISO>/SKILL.md
//                        (preserving user diffs) before installing the thin
//                        reference. `force: false` (default) still archives
//                        and rewrites — `force` only affects whether we
//                        overwrite an existing archive collision.
//   - "already-migrated" — content already matches the thin reference (or
//                          frontmatter `name: migrate` with description that
//                          does NOT mention Supabase). Returns `migrated:
//                          false` and a non-error reason.
//
// Safety guarantees:
//   - Never `rm` — archives are timestamped paths; if a collision occurs we
//     append a monotonic counter (`-2`, `-3`, …) instead of overwriting.
//   - Reference content is written via `fs.writeFileSync`. The legacy file is
//     copied via `fs.copyFileSync` into the archive before being replaced.
//   - Idempotent: invoking twice on the same repo is a no-op the second
//     time.
//
// See spec § "Task 8.1 (migrator) — collision handling" for archive naming.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MigrateLegacySkillOptions {
  repoRoot: string;
  /**
   * If an archive directory with the same ISO timestamp already exists, the
   * migrator appends a monotonic counter rather than overwriting. `force`
   * has no destructive meaning today; reserved for future "yes, replace
   * already-migrated content" semantics. Currently informational only.
   */
  force?: boolean;
}

export interface MigrateLegacySkillResult {
  migrated: boolean;
  /** Short string describing why we did or did not migrate. */
  reason?: string;
  /** Absolute path to the archive directory (only set when migrated=true). */
  archivePath?: string;
  /** Human-readable per-step audit trail of every move/skip decision. */
  report: string[];
}

/**
 * The thin reference SKILL.md content for `skills/migrate/`. After migration
 * this is what the slot must contain. Kept in sync with the dispatcher's
 * envelope contract (see src/core/migrate/dispatcher.ts).
 */
export const THIN_MIGRATE_SKILL_MD = `---
name: migrate
description: Generic migration orchestrator. Reads .autopilot/stack.md, builds an invocation envelope, dispatches to the configured rich migrate skill (migrate.supabase@1, migrate.prisma@1, …), and parses the ResultArtifact.
---

# /migrate — Generic migration orchestrator

This is the thin entrypoint. It does not run migrations itself — it dispatches
to the rich skill named in \`.autopilot/stack.md\` under \`migrate.skill\`.

## How it works

1. Read \`.autopilot/stack.md\` for \`migrate.skill\` (e.g. \`migrate.supabase@1\`,
   \`migrate.prisma@1\`, \`none@1\`).
2. Build an invocation envelope (contractVersion, invocationId, nonce, env,
   dryRun, gitBase/Head, changedFiles, etc.).
3. Resolve the stable skill ID via \`presets/aliases.lock.json\`.
4. Spawn the resolved skill subprocess with \`AUTOPILOT_ENVELOPE\` set.
5. Read the \`ResultArtifact\` written to \`AUTOPILOT_RESULT_PATH\`.
6. Branch the pipeline on \`status\` and \`nextActions\`.

## Configuration

Set \`migrate.skill\` in \`.autopilot/stack.md\`:

\`\`\`yaml
schema_version: 1
migrate:
  skill: "migrate.supabase@1"   # or migrate.prisma@1, none@1, …
  policy:
    allow_prod_in_ci: false
    require_clean_git: true
    require_manual_approval: true
    require_dry_run_first: false
\`\`\`

For the rich Supabase runner (\`data/deltas\`, \`types/supabase.ts\`,
\`.claude/supabase-envs.json\`) see \`skills/migrate-supabase/SKILL.md\`.

For an explicit no-op (docs-only PRs, no DB yet) see
\`skills/migrate-none/SKILL.md\`.
`;

/**
 * Sha256 fingerprint of the original Delegance legacy SKILL.md (the one
 * shipped in commit d84f8ff before Task 4.1 added the manifest). Used to
 * recognise a "clean" legacy install.
 *
 * Computed at import time from the canonical legacy text below. We embed the
 * canonical text rather than just the hash so future maintainers can audit.
 */
const LEGACY_CANONICAL_SKILL_MD = `---
name: migrate
description: Run database migrations against Supabase environments (dev → QA → prod). Validates SQL, executes with ledger tracking, and auto-generates types/supabase.ts.
---

# Database Migration

Run a migration through the dev → QA → prod pipeline with validation at each step.

## Usage

### 1. Identify the migration file

If given as argument, use that. Otherwise find the most recently modified \`.sql\` file in \`data/deltas/\`.

### 2. Validate (dry run on dev)

\`\`\`bash
npx tsx scripts/supabase/migrate.ts <file> --env dev --dry-run
\`\`\`

Present validation results. If errors, help the user fix them before proceeding.

### 3. Run on dev

\`\`\`bash
npx tsx scripts/supabase/migrate.ts <file> --env dev
\`\`\`

### 4. Ask the user

> "Migration succeeded on dev. \`types/supabase.ts\` updated. Promote to QA?"

### 5. Run on QA

\`\`\`bash
npx tsx scripts/supabase/migrate.ts --promote qa
\`\`\`

### 6. Ask the user

> "Migration succeeded on QA. Promote to prod?"

### 7. Run on prod

\`\`\`bash
npx tsx scripts/supabase/migrate.ts --promote prod --confirm-prod
\`\`\`

### 8. Commit

After all environments are done, commit the updated \`types/supabase.ts\` and the migration file:

\`\`\`bash
git add types/supabase.ts data/deltas/<migration-file>
git commit -m "feat: <description of schema change>"
\`\`\`

## Flags

| Flag | Purpose |
|------|---------|
| \`--env dev\\|qa\\|prod\` | Target environment |
| \`--dry-run\` | Validate only, don't execute |
| \`--force\` | Allow destructive operations (DROP, TRUNCATE) |
| \`--confirm-prod\` | Required for prod execution |
| \`--promote qa\\|prod\` | Run missing migrations from source env |

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

- \`.claude/supabase-envs.json\` with \`dbUrl\` for each env (gitignored)
- \`postgres\` npm package installed
`;

interface ParsedFrontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = content.slice(3, end).trim();
  const out: ParsedFrontmatter = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2] ?? '';
    if (key === 'name') out.name = value.trim().replace(/^["']|["']$/g, '');
    else if (key === 'description') out.description = value.trim();
  }
  return out;
}

type LegacyDetection =
  | { kind: 'clean' }
  | { kind: 'user-edited' }
  | { kind: 'not-legacy' }
  | { kind: 'already-thin' };

function detectLegacyShape(content: string): LegacyDetection {
  // Exact-match check first (clean install).
  if (content === LEGACY_CANONICAL_SKILL_MD) {
    return { kind: 'clean' };
  }
  if (content === THIN_MIGRATE_SKILL_MD) {
    return { kind: 'already-thin' };
  }
  const fm = parseFrontmatter(content);
  if (!fm) return { kind: 'not-legacy' };
  if (fm.name !== 'migrate') {
    // Some other skill? Don't touch.
    return { kind: 'not-legacy' };
  }
  // Frontmatter says name: migrate but content drifted. If description still
  // refers to Supabase, treat as legacy that the user has edited.
  if (fm.description && /supabase/i.test(fm.description)) {
    return { kind: 'user-edited' };
  }
  // name: migrate but description doesn't reference Supabase → already a
  // generic / thin variant the user has authored themselves.
  return { kind: 'already-thin' };
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[.:]/g, '-');
}

/**
 * Pick a non-colliding archive path. If `base` already exists, append `-2`,
 * `-3`, … until we find a free slot. Never overwrites.
 */
function pickArchivePath(base: string): string {
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  // Extremely unlikely; surface as an error rather than silently overwriting.
  throw new Error(`Archive collision: exhausted counter at ${base}`);
}

export function migrateLegacySkill(
  opts: MigrateLegacySkillOptions,
): MigrateLegacySkillResult {
  const repoRoot = path.resolve(opts.repoRoot);
  const skillDir = path.join(repoRoot, 'skills', 'migrate');
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const report: string[] = [];

  if (!fs.existsSync(skillMdPath)) {
    report.push(
      `skipped: ${path.relative(repoRoot, skillMdPath)} not present — nothing to migrate`,
    );
    return { migrated: false, reason: 'no-skill-md', report };
  }

  const content = fs.readFileSync(skillMdPath, 'utf8');
  const detection = detectLegacyShape(content);

  if (detection.kind === 'already-thin') {
    report.push(
      `skipped: ${path.relative(repoRoot, skillMdPath)} already matches the thin reference (or a custom non-Supabase variant)`,
    );
    return { migrated: false, reason: 'already-migrated', report };
  }
  if (detection.kind === 'not-legacy') {
    report.push(
      `skipped: ${path.relative(repoRoot, skillMdPath)} has unexpected frontmatter — leaving untouched`,
    );
    return { migrated: false, reason: 'not-legacy-shape', report };
  }

  const stamp = isoStamp();
  const archiveBase =
    detection.kind === 'clean'
      ? path.join(repoRoot, 'skills', `migrate.archive-${stamp}`)
      : path.join(repoRoot, 'skills', `migrate.backup-${stamp}`);
  const archiveDir = pickArchivePath(archiveBase);

  fs.mkdirSync(archiveDir, { recursive: true });
  const archivedSkillMd = path.join(archiveDir, 'SKILL.md');
  fs.copyFileSync(skillMdPath, archivedSkillMd);
  report.push(
    `archived: ${path.relative(repoRoot, skillMdPath)} → ${path.relative(repoRoot, archivedSkillMd)} (${detection.kind})`,
  );

  // Replace skills/migrate/SKILL.md with the thin reference.
  fs.writeFileSync(skillMdPath, THIN_MIGRATE_SKILL_MD, 'utf8');
  report.push(
    `wrote: ${path.relative(repoRoot, skillMdPath)} (thin generic orchestrator reference)`,
  );

  return {
    migrated: true,
    reason: detection.kind === 'clean' ? 'clean-archive' : 'user-edited-backup',
    archivePath: archiveDir,
    report,
  };
}

/**
 * Returns true iff `skills/migrate/SKILL.md` looks like the legacy Delegance
 * Supabase shape (clean OR user-edited). Used by the doctor for *detection*
 * before deciding whether to run the migrator. Never reads from outside
 * `repoRoot`.
 */
export function detectsLegacyMigrateSkill(repoRoot: string): boolean {
  const skillMdPath = path.join(
    path.resolve(repoRoot),
    'skills',
    'migrate',
    'SKILL.md',
  );
  if (!fs.existsSync(skillMdPath)) return false;
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const det = detectLegacyShape(content);
  return det.kind === 'clean' || det.kind === 'user-edited';
}
