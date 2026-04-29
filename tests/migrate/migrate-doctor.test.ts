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
