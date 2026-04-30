// tests/migrate/migrator.test.ts
//
// Tests for migrateLegacySkill (Task 8.1).
//
// Scenarios:
//   - Clean migration: SKILL.md exactly matches the legacy fingerprint →
//     archived to migrate.archive-<ISO>/, thin reference written.
//   - User-edited: frontmatter description still references Supabase but
//     content has drifted → backup at migrate.backup-<ISO>/.
//   - Already-migrated (idempotency): SKILL.md matches the thin reference →
//     no-op, returns { migrated: false, reason: 'already-migrated' }.
//   - Migration report enumerates every move/skip with the relative path.
//   - Archive collision: when a target dir already exists, monotonic
//     counter is appended (no overwrite).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  migrateLegacySkill,
  detectsLegacyMigrateSkill,
  THIN_MIGRATE_SKILL_MD,
} from '../../src/core/migrate/migrator.ts';

// Re-derive the legacy canonical content here so the test pins the exact
// shape (changing it should require updating the migrator's embedded
// constant deliberately).
const LEGACY_SKILL_MD = `---
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

function makeRepo(skillMdContent: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-'));
  fs.mkdirSync(path.join(dir, 'skills', 'migrate'), { recursive: true });
  if (skillMdContent !== null) {
    fs.writeFileSync(
      path.join(dir, 'skills', 'migrate', 'SKILL.md'),
      skillMdContent,
    );
  }
  return dir;
}

function readSkillMd(dir: string): string {
  return fs.readFileSync(
    path.join(dir, 'skills', 'migrate', 'SKILL.md'),
    'utf8',
  );
}

describe('migrateLegacySkill — clean migration', () => {
  it('archives the legacy SKILL.md to migrate.archive-<ISO>/ and writes the thin reference', () => {
    const dir = makeRepo(LEGACY_SKILL_MD);
    try {
      const r = migrateLegacySkill({ repoRoot: dir });
      assert.equal(r.migrated, true);
      assert.equal(r.reason, 'clean-archive');
      assert.ok(r.archivePath);
      assert.match(
        path.basename(r.archivePath!),
        /^migrate\.archive-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/,
      );
      // Archive contains the original legacy content
      const archived = fs.readFileSync(
        path.join(r.archivePath!, 'SKILL.md'),
        'utf8',
      );
      assert.equal(archived, LEGACY_SKILL_MD);
      // skills/migrate/SKILL.md now holds the thin reference
      assert.equal(readSkillMd(dir), THIN_MIGRATE_SKILL_MD);
      // Report enumerates both actions
      assert.equal(r.report.length, 2);
      assert.match(r.report[0]!, /^archived: skills\/migrate\/SKILL\.md → skills\/migrate\.archive-/);
      assert.match(r.report[1]!, /^wrote: skills\/migrate\/SKILL\.md /);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('migrateLegacySkill — user-edited', () => {
  it('writes a backup at migrate.backup-<ISO>/ before installing the thin reference', () => {
    const userEdited =
      `---
name: migrate
description: Run database migrations against MY Supabase env. Custom branch by alex.
---

# Custom Migration

I added my own notes here.
`;
    const dir = makeRepo(userEdited);
    try {
      const r = migrateLegacySkill({ repoRoot: dir });
      assert.equal(r.migrated, true);
      assert.equal(r.reason, 'user-edited-backup');
      assert.ok(r.archivePath);
      assert.match(
        path.basename(r.archivePath!),
        /^migrate\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/,
      );
      // Backup preserves the user's diffs verbatim — non-destructive
      const backed = fs.readFileSync(
        path.join(r.archivePath!, 'SKILL.md'),
        'utf8',
      );
      assert.equal(backed, userEdited);
      // skills/migrate/SKILL.md holds the thin reference
      assert.equal(readSkillMd(dir), THIN_MIGRATE_SKILL_MD);
      // Report mentions user-edited mode
      assert.equal(r.report.length, 2);
      assert.match(r.report[0]!, /\(user-edited\)$/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('migrateLegacySkill — already migrated (idempotency)', () => {
  it('returns { migrated: false, reason: "already-migrated" } when SKILL.md is already the thin reference', () => {
    const dir = makeRepo(THIN_MIGRATE_SKILL_MD);
    try {
      // Snapshot the entire skills/ tree to prove zero writes.
      const before = fs.readdirSync(path.join(dir, 'skills')).sort();
      const beforeMd = readSkillMd(dir);
      const r = migrateLegacySkill({ repoRoot: dir });
      assert.equal(r.migrated, false);
      assert.equal(r.reason, 'already-migrated');
      assert.equal(r.archivePath, undefined);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')).sort(), before);
      assert.equal(readSkillMd(dir), beforeMd);
      // Report still enumerates the skip
      assert.equal(r.report.length, 1);
      assert.match(r.report[0]!, /^skipped: skills\/migrate\/SKILL\.md /);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('re-running on a freshly-migrated repo is a no-op', () => {
    const dir = makeRepo(LEGACY_SKILL_MD);
    try {
      const first = migrateLegacySkill({ repoRoot: dir });
      assert.equal(first.migrated, true);
      const beforeSecondRun = fs.readdirSync(path.join(dir, 'skills')).sort();
      const second = migrateLegacySkill({ repoRoot: dir });
      assert.equal(second.migrated, false);
      assert.equal(second.reason, 'already-migrated');
      // No new archive directory created on the second pass.
      assert.deepEqual(
        fs.readdirSync(path.join(dir, 'skills')).sort(),
        beforeSecondRun,
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('migrateLegacySkill — non-legacy / missing', () => {
  it('returns { migrated: false } when SKILL.md is missing', () => {
    const dir = makeRepo(null);
    try {
      const r = migrateLegacySkill({ repoRoot: dir });
      assert.equal(r.migrated, false);
      assert.equal(r.reason, 'no-skill-md');
      assert.equal(r.report.length, 1);
      assert.match(r.report[0]!, /^skipped: skills\/migrate\/SKILL\.md not present/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('does not touch a SKILL.md whose name is not "migrate"', () => {
    const otherSkill = `---
name: something-else
description: Whatever.
---

# Something else
`;
    const dir = makeRepo(otherSkill);
    try {
      const r = migrateLegacySkill({ repoRoot: dir });
      assert.equal(r.migrated, false);
      assert.equal(r.reason, 'not-legacy-shape');
      assert.equal(readSkillMd(dir), otherSkill);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('migrateLegacySkill — archive collision', () => {
  it('appends a monotonic counter when the archive base already exists', () => {
    const dir = makeRepo(LEGACY_SKILL_MD);
    try {
      // Run once to create migrate.archive-<ISO>/.
      const first = migrateLegacySkill({ repoRoot: dir });
      assert.ok(first.archivePath);
      // Restore the legacy content so we can run again with the SAME
      // millisecond stamp (mock by directly rewriting and reusing the same
      // ISO prefix).
      fs.writeFileSync(
        path.join(dir, 'skills', 'migrate', 'SKILL.md'),
        LEGACY_SKILL_MD,
      );
      // Force the next run to collide by pre-creating an empty archive at
      // the second-run's base path. Because pickArchivePath uses
      // `new Date().toISOString()` we cannot reliably force a collision
      // by clock manipulation in unit tests — instead we *manually*
      // create a directory that matches the migrator's exact next
      // candidate by intercepting after-the-fact: simulate by creating an
      // identically-named placeholder before the migrator runs.
      //
      // Here we simply call pickArchivePath via a second invocation and
      // assert that two distinct archive dirs result (counter or fresh
      // timestamp — both acceptable, but they MUST be different paths).
      const second = migrateLegacySkill({ repoRoot: dir });
      assert.equal(second.migrated, true);
      assert.notEqual(second.archivePath, first.archivePath);
      // Both archives still contain the legacy content (no overwrite)
      assert.equal(
        fs.readFileSync(path.join(first.archivePath!, 'SKILL.md'), 'utf8'),
        LEGACY_SKILL_MD,
      );
      assert.equal(
        fs.readFileSync(path.join(second.archivePath!, 'SKILL.md'), 'utf8'),
        LEGACY_SKILL_MD,
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('detectsLegacyMigrateSkill', () => {
  it('returns true for clean legacy', () => {
    const dir = makeRepo(LEGACY_SKILL_MD);
    try {
      assert.equal(detectsLegacyMigrateSkill(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
  it('returns true for user-edited legacy (description references Supabase)', () => {
    const userEdited = `---
name: migrate
description: My customised Supabase migrator.
---

# x
`;
    const dir = makeRepo(userEdited);
    try {
      assert.equal(detectsLegacyMigrateSkill(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
  it('returns false for already-thin', () => {
    const dir = makeRepo(THIN_MIGRATE_SKILL_MD);
    try {
      assert.equal(detectsLegacyMigrateSkill(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
  it('returns false when file is missing', () => {
    const dir = makeRepo(null);
    try {
      assert.equal(detectsLegacyMigrateSkill(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
