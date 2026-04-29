// tests/migrate/doctor-checks.test.ts
//
// Tests for doctor checks (Task 7.1). Each of the 8 checks is exercised
// against a fixture repo built per-test. All checks must be read-only —
// see the "no writes" assertion at the bottom of runAllChecks.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  stackMdExists,
  schemaValidates,
  skillResolves,
  perEnvCommandsExplicit,
  policyFieldsValid,
  projectRootHasToolchain,
  deprecatedKeysAbsent,
  envFileSafety,
  runAllChecks,
} from '../../src/core/migrate/doctor-checks.ts';

// Build a fake repo with a real presets/aliases.lock.json + skills/
// tree (matching makeFakeRepoWithStandardAliases in alias-resolver tests),
// optionally with a stack.md and a project_root tree.
function makeRepo(opts: {
  stackMd?: string;
  files?: Record<string, string>;
  /** If true, initialize a git repo and commit `files` (for env_file safety tests). */
  initGitAndCommit?: boolean;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));

  // Skills + alias map (so resolveSkill works against this fixture)
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

  // User files
  for (const [p, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(dir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  if (opts.stackMd !== undefined) {
    fs.mkdirSync(path.join(dir, '.autopilot'));
    fs.writeFileSync(path.join(dir, '.autopilot', 'stack.md'), opts.stackMd);
  }

  if (opts.initGitAndCommit) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  }

  return dir;
}

const STACK_PRISMA = `
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

const STACK_SUPABASE = `
schema_version: 1
migrate:
  skill: "migrate.supabase@1"
  project_root: "."
  supabase:
    deltas_dir: "data/deltas"
    types_out: "types/supabase.ts"
    envs_file: ".claude/supabase-envs.json"
  policy:
    allow_prod_in_ci: false
`;

// 1. stackMdExists
describe('stackMdExists', () => {
  it('passes when .autopilot/stack.md exists', () => {
    const dir = makeRepo({
      stackMd: STACK_PRISMA,
      files: { 'prisma/schema.prisma': 'x', 'prisma/migrations/.keep': '' },
    });
    try {
      const r = stackMdExists(dir);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails with run-init hint when stack.md is missing', () => {
    const dir = makeRepo({});
    try {
      const r = stackMdExists(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /stack\.md not found/);
      assert.match(r.fixHint!, /init/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// 2. schemaValidates
describe('schemaValidates', () => {
  it('passes for a valid stack.md', () => {
    const dir = makeRepo({ stackMd: STACK_PRISMA });
    try {
      const r = schemaValidates(dir);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails when stack.md is missing schema_version', () => {
    const dir = makeRepo({
      stackMd: `migrate:\n  skill: "migrate@1"\n  envs:\n    dev:\n      command: { exec: prisma, args: [migrate, dev] }\n`,
    });
    try {
      const r = schemaValidates(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /schema validation failed/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails with cross-field error when prod env reuses dev command', () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
    prod:
      command: { exec: "prisma", args: ["migrate", "dev"] }
`,
    });
    try {
      const r = schemaValidates(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /dev-command-reused-for-non-dev/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// 3. skillResolves
describe('skillResolves', () => {
  it('passes for a stable ID', () => {
    const dir = makeRepo({ stackMd: STACK_PRISMA });
    try {
      const r = skillResolves(dir);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('reports normalized-from-raw with a stable-ID fix hint', () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
`,
    });
    try {
      const r = skillResolves(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /raw alias/);
      assert.match(r.fixHint!, /migrate@1/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails for an unknown skill', () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "bogus@9"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
`,
    });
    try {
      const r = skillResolves(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /failed to resolve/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// 4. perEnvCommandsExplicit
describe('perEnvCommandsExplicit', () => {
  it('passes when each env has its own command', () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
    prod:
      command: { exec: "prisma", args: ["migrate", "deploy"] }
`,
    });
    try {
      const r = perEnvCommandsExplicit(dir);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails when prod reuses dev.command and lists offenders', () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
    prod:
      command: { exec: "prisma", args: ["migrate", "dev"] }
    qa:
      command: { exec: "prisma", args: ["migrate", "dev"] }
`,
    });
    try {
      const r = perEnvCommandsExplicit(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /prod/);
      assert.match(r.message!, /qa/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// 5. policyFieldsValid
describe('policyFieldsValid', () => {
  it('passes when all policy fields are booleans', () => {
    const dir = makeRepo({ stackMd: STACK_PRISMA });
    try {
      const r = policyFieldsValid(dir);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails when a policy field is a non-boolean', () => {
    // Schema would normally reject this — doctor surfaces it again.
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
  policy:
    allow_prod_in_ci: "yes"
    require_clean_git: 1
`,
    });
    try {
      const r = policyFieldsValid(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /allow_prod_in_ci/);
      assert.match(r.message!, /require_clean_git/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// 6. projectRootHasToolchain
describe('projectRootHasToolchain', () => {
  it('passes for migrate.supabase@1 when data/deltas + envs file exist', () => {
    const dir = makeRepo({
      stackMd: STACK_SUPABASE,
      files: {
        'data/deltas/.keep': '',
        '.claude/supabase-envs.json': '{}',
      },
    });
    try {
      const r = projectRootHasToolchain(dir);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails for migrate.supabase@1 when toolchain files are missing', () => {
    const dir = makeRepo({ stackMd: STACK_SUPABASE });
    try {
      const r = projectRootHasToolchain(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /missing expected toolchain files/);
      assert.match(r.message!, /data\/deltas/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('passes for migrate@1 when prisma toolchain present', () => {
    const dir = makeRepo({
      stackMd: STACK_PRISMA,
      files: {
        'prisma/schema.prisma': 'model User { id String @id }',
        'prisma/migrations/.keep': '',
      },
    });
    try {
      const r = projectRootHasToolchain(dir);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails for migrate@1 when no recognized toolchain files exist under project_root', () => {
    const dir = makeRepo({ stackMd: STACK_PRISMA });
    try {
      const r = projectRootHasToolchain(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /does not contain any recognized migration toolchain/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('passes for none@1 (no-op skill)', () => {
    const dir = makeRepo({
      stackMd: `schema_version: 1\nmigrate:\n  skill: "none@1"\n`,
    });
    try {
      const r = projectRootHasToolchain(dir);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails when project_root path does not exist', () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  project_root: "does/not/exist"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
`,
    });
    try {
      const r = projectRootHasToolchain(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /does not exist/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// 7. deprecatedKeysAbsent
describe('deprecatedKeysAbsent', () => {
  it('passes when no deprecated keys are present', () => {
    const dir = makeRepo({ stackMd: STACK_PRISMA });
    try {
      const r = deprecatedKeysAbsent(dir);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('reports top-level dev_command and points at --fix without rewriting', () => {
    const stackMdContent = `
dev_command: "prisma migrate dev"
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
`;
    const dir = makeRepo({ stackMd: stackMdContent });
    try {
      const r = deprecatedKeysAbsent(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /dev_command/);
      assert.match(r.fixHint!, /--fix/);
      // Read-only: file unchanged
      const after = fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8');
      assert.equal(after, stackMdContent, 'check must not mutate stack.md');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// 8. envFileSafety
describe('envFileSafety', () => {
  it('passes for a relative env_file that is not git-tracked', () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
      env_file: ".env.dev"
`,
      files: { '.gitignore': '.env.dev\n' },
      initGitAndCommit: true,
    });
    try {
      // Now drop a .env.dev (after commit so it's untracked)
      fs.writeFileSync(path.join(dir, '.env.dev'), 'FOO=bar');
      const r = envFileSafety(dir);
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails when env_file uses .. traversal', () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
      env_file: "../secrets/.env"
`,
    });
    try {
      const r = envFileSafety(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /traversal/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails when env_file is absolute', () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
      env_file: "/etc/secrets/.env"
`,
    });
    try {
      const r = envFileSafety(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /absolute/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('fails when env_file is git-tracked', () => {
    const dir = makeRepo({
      stackMd: `
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
      env_file: ".env.dev"
`,
      files: { '.env.dev': 'FOO=bar' },
      initGitAndCommit: true,
    });
    try {
      const r = envFileSafety(dir);
      assert.equal(r.ok, false);
      assert.match(r.message!, /git-tracked/);
      assert.match(r.fixHint!, /git rm --cached/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// runAllChecks aggregator
describe('runAllChecks', () => {
  it('returns 8 named results in spec order and writes nothing', () => {
    const dir = makeRepo({
      stackMd: STACK_PRISMA,
      files: {
        'prisma/schema.prisma': 'x',
        'prisma/migrations/.keep': '',
      },
    });
    try {
      const stackBefore = fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8');
      const results = runAllChecks(dir);
      assert.equal(results.length, 8);
      assert.deepEqual(
        results.map(r => r.name),
        [
          'stackMdExists',
          'schemaValidates',
          'skillResolves',
          'perEnvCommandsExplicit',
          'policyFieldsValid',
          'projectRootHasToolchain',
          'deprecatedKeysAbsent',
          'envFileSafety',
        ],
      );
      // All checks pass on this clean fixture
      for (const r of results) {
        assert.equal(r.result.ok, true, `${r.name}: ${r.result.message}`);
      }
      const stackAfter = fs.readFileSync(path.join(dir, '.autopilot', 'stack.md'), 'utf8');
      assert.equal(stackAfter, stackBefore, 'runAllChecks must not mutate stack.md');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
