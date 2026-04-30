// tests/migrate/migrate-doctor.test.ts
//
// Tests for runMigrateDoctor (Task 7.2).
//
// - Read-only mode: confirms zero writes via golden-file diff.
// - --fix mode: confirms each auto-fix is applied with the exact
//   expected mutation log.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { runMigrateDoctor } from '../../src/cli/migrate-doctor.ts';
import { THIN_MIGRATE_SKILL_MD } from '../../src/core/migrate/migrator.ts';

const LEGACY_MIGRATE_SKILL_MD = `---
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

function makeRepo(opts: {
  stackMd?: string;
  files?: Record<string, string>;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-doc-'));

  fs.mkdirSync(path.join(dir, 'skills', 'migrate'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'migrate-supabase'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'migrate-none'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'migrate', 'SKILL.md'), '# migrate');
  fs.writeFileSync(path.join(dir, 'skills', 'migrate-supabase', 'SKILL.md'), '# supabase');
  fs.writeFileSync(path.join(dir, 'skills', 'migrate-none', 'SKILL.md'), '# none');
  fs.mkdirSync(path.join(dir, 'presets'));
  fs.writeFileSync(
    path.join(dir, 'presets', 'aliases.lock.json'),
    JSON.stringify({
      schemaVersion: 1,
      aliases: [
        { stableId: 'migrate@1', resolvesTo: 'skills/migrate/', rawAliases: ['migrate'] },
        { stableId: 'migrate.supabase@1', resolvesTo: 'skills/migrate-supabase/', rawAliases: ['migrate-supabase'] },
        { stableId: 'none@1', resolvesTo: 'skills/migrate-none/', rawAliases: ['none', 'skip'] },
      ],
    }),
  );

  for (const [p, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(dir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  if (opts.stackMd !== undefined) {
    fs.mkdirSync(path.join(dir, '.autopilot'));
    fs.writeFileSync(path.join(dir, '.autopilot', 'stack.md'), opts.stackMd);
  }

  return dir;
}

describe('runMigrateDoctor — read-only (default)', () => {
  it('returns allOk=true and writes nothing on a clean fixture', async () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  project_root: "."
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
  policy:
    allow_prod_in_ci: false
    require_clean_git: true
    require_manual_approval: true
    require_dry_run_first: false
`,
      files: {
        'prisma/schema.prisma': 'model User { id String @id }',
        'prisma/migrations/.keep': '',
      },
    });
    try {
      const before = fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8');
      const r = await runMigrateDoctor({ repoRoot: dir });
      assert.equal(r.allOk, true, JSON.stringify(r.results.filter(x => !x.result.ok)));
      assert.equal(r.mutations, undefined);
      const after = fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8');
      assert.equal(after, before, 'plain doctor must never write');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns allOk=false and writes nothing when stack.md has issues', async () => {
    // dev_command (top-level) deprecation + missing schema_version
    const stackMdContent = `
dev_command: "prisma migrate dev"
migrate:
  skill: "migrate@1"
  project_root: "."
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
`;
    const dir = makeRepo({
      stackMd: stackMdContent,
      files: {
        'prisma/schema.prisma': 'model User { id String @id }',
        'prisma/migrations/.keep': '',
      },
    });
    try {
      const r = await runMigrateDoctor({ repoRoot: dir });
      assert.equal(r.allOk, false);
      // Both deprecated-keys and schema-validation should fail
      const namesFailing = r.results.filter(x => !x.result.ok).map(x => x.name);
      assert.ok(namesFailing.includes('deprecatedKeysAbsent'));
      assert.ok(namesFailing.includes('schemaValidates'));
      // Verify NO write
      const after = fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8');
      assert.equal(after, stackMdContent);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('runMigrateDoctor — --fix mode', () => {
  it('migrates top-level dev_command → envs.dev.command and removes the legacy key', async () => {
    const dir = makeRepo({
      stackMd: `
dev_command: "prisma migrate dev"
schema_version: 1
migrate:
  skill: "migrate@1"
  project_root: "."
  policy:
    allow_prod_in_ci: false
    require_clean_git: true
    require_manual_approval: true
    require_dry_run_first: false
`,
      files: {
        'prisma/schema.prisma': 'model User { id String @id }',
        'prisma/migrations/.keep': '',
      },
    });
    try {
      const r = await runMigrateDoctor({ repoRoot: dir, fix: true });
      assert.ok(r.mutations);
      assert.ok(
        r.mutations!.some(m => /dev_command.*envs\.dev\.command/.test(m)),
        `expected migration mutation in: ${JSON.stringify(r.mutations)}`,
      );
      // After fix: top-level key is gone, envs.dev.command holds the value
      const after = yaml.load(
        fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8'),
      ) as any;
      assert.equal(after.dev_command, undefined);
      assert.equal(after.migrate.envs.dev.command, 'prisma migrate dev');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('adds missing schema_version: 1', async () => {
    const dir = makeRepo({
      stackMd: `
migrate:
  skill: "migrate@1"
  project_root: "."
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
  policy:
    allow_prod_in_ci: false
    require_clean_git: true
    require_manual_approval: true
    require_dry_run_first: false
`,
      files: {
        'prisma/schema.prisma': 'model User { id String @id }',
        'prisma/migrations/.keep': '',
      },
    });
    try {
      const r = await runMigrateDoctor({ repoRoot: dir, fix: true });
      assert.deepEqual(
        r.mutations!.filter(m => /schema_version/.test(m)),
        ['added schema_version: 1'],
      );
      const after = yaml.load(
        fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8'),
      ) as any;
      assert.equal(after.schema_version, 1);
      assert.equal(r.allOk, true, JSON.stringify(r.results.filter(x => !x.result.ok)));
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('normalizes raw migrate.skill ("migrate") → stable ID ("migrate@1")', async () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate"
  project_root: "."
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
  policy:
    allow_prod_in_ci: false
    require_clean_git: true
    require_manual_approval: true
    require_dry_run_first: false
`,
      files: {
        'prisma/schema.prisma': 'x',
        'prisma/migrations/.keep': '',
      },
    });
    try {
      const r = await runMigrateDoctor({ repoRoot: dir, fix: true });
      assert.ok(
        r.mutations!.some(m => m.includes('normalized migrate.skill') && m.includes('migrate@1')),
        `expected normalization mutation; got: ${JSON.stringify(r.mutations)}`,
      );
      const after = yaml.load(
        fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8'),
      ) as any;
      assert.equal(after.migrate.skill, 'migrate@1');
      assert.equal(r.allOk, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('backfills missing default policy keys for migrate@1', async () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  project_root: "."
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
  policy:
    allow_prod_in_ci: true
`,
      files: {
        'prisma/schema.prisma': 'x',
        'prisma/migrations/.keep': '',
      },
    });
    try {
      const r = await runMigrateDoctor({ repoRoot: dir, fix: true });
      assert.ok(
        r.mutations!.some(m => /backfilled default policy keys/.test(m)),
        `expected backfill mutation; got: ${JSON.stringify(r.mutations)}`,
      );
      const after = yaml.load(
        fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8'),
      ) as any;
      // User's true value preserved
      assert.equal(after.migrate.policy.allow_prod_in_ci, true);
      // Missing keys backfilled
      assert.equal(after.migrate.policy.require_clean_git, true);
      assert.equal(after.migrate.policy.require_manual_approval, true);
      assert.equal(after.migrate.policy.require_dry_run_first, false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns empty mutations and writes nothing when stack.md is already clean', async () => {
    const stackMdContent = `
schema_version: 1
migrate:
  skill: "migrate@1"
  project_root: "."
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
  policy:
    allow_prod_in_ci: false
    require_clean_git: true
    require_manual_approval: true
    require_dry_run_first: false
`;
    const dir = makeRepo({
      stackMd: stackMdContent,
      files: {
        'prisma/schema.prisma': 'x',
        'prisma/migrations/.keep': '',
      },
    });
    try {
      const before = fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8');
      const r = await runMigrateDoctor({ repoRoot: dir, fix: true });
      assert.deepEqual(r.mutations, []);
      assert.equal(r.allOk, true);
      const after = fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8');
      assert.equal(after, before, 'no-op fix must not rewrite the file');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('combines multiple fixes in one pass', async () => {
    const dir = makeRepo({
      stackMd: `
dev_command: "prisma migrate dev"
migrate:
  skill: "migrate"
  project_root: "."
  policy:
    allow_prod_in_ci: false
`,
      files: {
        'prisma/schema.prisma': 'x',
        'prisma/migrations/.keep': '',
      },
    });
    try {
      const r = await runMigrateDoctor({ repoRoot: dir, fix: true });
      const muts = r.mutations!.join(' | ');
      assert.match(muts, /schema_version/);
      assert.match(muts, /dev_command/);
      assert.match(muts, /normalized migrate\.skill/);
      assert.match(muts, /backfilled default policy keys/);
      const after = yaml.load(
        fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8'),
      ) as any;
      assert.equal(after.schema_version, 1);
      assert.equal(after.dev_command, undefined);
      assert.equal(after.migrate.skill, 'migrate@1');
      assert.equal(after.migrate.envs.dev.command, 'prisma migrate dev');
      assert.equal(after.migrate.policy.require_clean_git, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('runMigrateDoctor — legacy /migrate skill migration (Task 8.2)', () => {
  it('runs the migrator under --fix and appends migration entries to mutations + writes a report', async () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  project_root: "."
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
  policy:
    allow_prod_in_ci: false
    require_clean_git: true
    require_manual_approval: true
    require_dry_run_first: false
`,
      files: {
        'prisma/schema.prisma': 'model User { id String @id }',
        'prisma/migrations/.keep': '',
      },
    });
    // Overwrite the default '# migrate' stub with the canonical legacy
    // SKILL.md so detectsLegacyMigrateSkill() fires.
    fs.writeFileSync(
      path.join(dir, 'skills', 'migrate', 'SKILL.md'),
      LEGACY_MIGRATE_SKILL_MD,
    );
    try {
      const r = await runMigrateDoctor({ repoRoot: dir, fix: true });
      assert.ok(r.mutations);
      const muts = r.mutations!.join(' | ');
      assert.match(
        muts,
        /migrator: archived: skills\/migrate\/SKILL\.md → skills\/migrate\.archive-/,
      );
      assert.match(muts, /migrator: wrote: skills\/migrate\/SKILL\.md /);
      assert.match(muts, /migrator: completed \(clean-archive\)/);
      assert.match(muts, /migrator: wrote migration report → \.autopilot\/migration-report-/);

      // skills/migrate/SKILL.md now holds the thin reference
      assert.equal(
        fs.readFileSync(path.join(dir, 'skills', 'migrate', 'SKILL.md'), 'utf8'),
        THIN_MIGRATE_SKILL_MD,
      );
      // An archive directory was created
      const skillsDirs = fs.readdirSync(path.join(dir, 'skills'));
      assert.ok(
        skillsDirs.some(d => /^migrate\.archive-/.test(d)),
        `expected archive dir in skills/, got: ${skillsDirs.join(',')}`,
      );
      // Migration report was written
      assert.ok(r.migrationReportPath);
      const reportContents = fs.readFileSync(r.migrationReportPath!, 'utf8');
      assert.match(reportContents, /Legacy \/migrate skill migration report/);
      assert.match(reportContents, /migrated: true/);
      assert.match(reportContents, /reason: clean-archive/);
      assert.match(reportContents, /archive: skills\/migrate\.archive-/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('does NOT run the migrator in read-only mode but surfaces detection as a failing check', async () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  project_root: "."
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
  policy:
    allow_prod_in_ci: false
    require_clean_git: true
    require_manual_approval: true
    require_dry_run_first: false
`,
      files: {
        'prisma/schema.prisma': 'model User { id String @id }',
        'prisma/migrations/.keep': '',
      },
    });
    fs.writeFileSync(
      path.join(dir, 'skills', 'migrate', 'SKILL.md'),
      LEGACY_MIGRATE_SKILL_MD,
    );
    try {
      const before = fs.readFileSync(
        path.join(dir, 'skills', 'migrate', 'SKILL.md'),
        'utf8',
      );
      const beforeSkills = fs.readdirSync(path.join(dir, 'skills')).sort();
      const r = await runMigrateDoctor({ repoRoot: dir });
      // Read-only: never writes, never sets mutations
      assert.equal(r.mutations, undefined);
      assert.equal(r.migrationReportPath, undefined);
      const after = fs.readFileSync(
        path.join(dir, 'skills', 'migrate', 'SKILL.md'),
        'utf8',
      );
      assert.equal(after, before, 'plain doctor must not run the migrator');
      assert.deepEqual(
        fs.readdirSync(path.join(dir, 'skills')).sort(),
        beforeSkills,
        'plain doctor must not create archive directories',
      );
      // But it DID surface the detection as a failing named check
      assert.equal(r.allOk, false);
      const failingNames = r.results.filter(x => !x.result.ok).map(x => x.name);
      assert.ok(
        failingNames.includes('legacyMigrateSkillAbsent'),
        `expected legacyMigrateSkillAbsent in failing checks; got: ${failingNames.join(',')}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
