// Integration test: monorepo with two workspaces using different migrate skills.
//
// Sets up a pnpm-workspace fixture:
//   packages/web -> migrate@1   (Prisma-style fake runner)
//   packages/api -> migrate.supabase@1  (Supabase-style fake runner)
//
// Each workspace has its own .autopilot/stack.md, presets/aliases.lock.json,
// skills/<name>/, and fake-runner.js. dispatch() is called once per workspace
// (with repoRoot = workspace path), and we assert:
//   1. findWorkspaces() discovers both packages
//   2. each workspace dispatches successfully and resolves the right skill
//   3. each workspace gets its OWN .autopilot/audit.log (no cross-workspace leak)
//   4. the audit log entry per workspace records the correct skill identity
//
// This is the smaller "smoke test" version per the task spec — full mixed-stack
// orchestration (a runMigrate driver that loops findWorkspaces) is out of scope
// here; the test exercises the dispatch-per-workspace primitive that drives it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dispatch } from '../../src/core/migrate/dispatcher.ts';
import { findWorkspaces } from '../../src/core/migrate/monorepo.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRISMA_RUNNER = path.resolve(__dirname, '../fixtures/integration/prisma-fixture/fake-runner.js');
const SUPABASE_RUNNER = path.resolve(__dirname, '../fixtures/integration/supabase-fixture/fake-runner.js');

function withCleanCIEnv<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const stripped = [
    'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'BUILDKITE', 'JENKINS_URL',
    'AUTOPILOT_CI_PROVIDER', 'AUTOPILOT_CI_POLICY', 'AUTOPILOT_TARGET_ENV', 'GITHUB_RUN_ID',
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of stripped) { saved[k] = process.env[k]; delete process.env[k]; }
  const restore = () => {
    for (const k of stripped) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
    return r;
  } catch (err) {
    restore();
    throw err;
  }
}

function setupPrismaWorkspace(wsRoot: string): void {
  fs.mkdirSync(path.join(wsRoot, 'prisma', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'prisma', 'schema.prisma'), 'model User { id String @id }');
  fs.writeFileSync(path.join(wsRoot, 'prisma', 'migrations', '20260429_init.sql'), '-- migration');

  fs.mkdirSync(path.join(wsRoot, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'presets', 'aliases.lock.json'), JSON.stringify({
    schemaVersion: 1,
    aliases: [
      { stableId: 'migrate@1', resolvesTo: 'skills/migrate/', rawAliases: ['migrate'] },
    ],
  }));

  const skillDir = path.join(wsRoot, 'skills', 'migrate');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# migrate');
  fs.writeFileSync(path.join(skillDir, 'skill.manifest.json'), JSON.stringify({
    skillId: 'migrate@1',
    skill_runtime_api_version: '1.0',
    min_runtime: '5.0.0',
    max_runtime: '5.x',
  }));

  fs.copyFileSync(PRISMA_RUNNER, path.join(wsRoot, 'fake-runner.js'));

  const stackMd = `schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "node", args: ["./fake-runner.js"] }
  policy:
    allow_prod_in_ci: false
    require_clean_git: false
    require_manual_approval: false
    require_dry_run_first: false
`;
  fs.mkdirSync(path.join(wsRoot, '.autopilot'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, '.autopilot', 'stack.md'), stackMd);
}

function setupSupabaseWorkspace(wsRoot: string): void {
  fs.mkdirSync(path.join(wsRoot, 'data', 'deltas'), { recursive: true });
  fs.writeFileSync(
    path.join(wsRoot, 'data', 'deltas', '20260429000000_init.sql'),
    '-- supabase migration\n',
  );
  fs.mkdirSync(path.join(wsRoot, 'types'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'types', 'supabase.ts'), '// generated\n');
  fs.writeFileSync(path.join(wsRoot, '.env.dev'), 'SUPABASE_PROJECT_REF=local\n');

  fs.mkdirSync(path.join(wsRoot, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'presets', 'aliases.lock.json'), JSON.stringify({
    schemaVersion: 1,
    aliases: [
      { stableId: 'migrate.supabase@1', resolvesTo: 'skills/migrate-supabase/', rawAliases: ['migrate-supabase'] },
    ],
  }));

  const skillDir = path.join(wsRoot, 'skills', 'migrate-supabase');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# migrate-supabase');
  fs.writeFileSync(path.join(skillDir, 'skill.manifest.json'), JSON.stringify({
    skillId: 'migrate.supabase@1',
    skill_runtime_api_version: '1.0',
    min_runtime: '5.0.0',
    max_runtime: '5.x',
  }));

  fs.copyFileSync(SUPABASE_RUNNER, path.join(wsRoot, 'fake-runner.js'));

  const stackMd = `schema_version: 1
migrate:
  skill: "migrate.supabase@1"
  supabase:
    deltas_dir: "data/deltas"
    types_out: "types/supabase.ts"
    envs_file: ".env.dev"
  envs:
    dev:
      command: { exec: "node", args: ["./fake-runner.js"] }
  policy:
    allow_prod_in_ci: false
    require_clean_git: false
    require_manual_approval: false
    require_dry_run_first: false
`;
  fs.mkdirSync(path.join(wsRoot, '.autopilot'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, '.autopilot', 'stack.md'), stackMd);
}

function setupMonorepo(): { repoRoot: string; webDir: string; apiDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-int-'));

  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'a'], { cwd: dir });

  // pnpm-workspace declaration so findWorkspaces sees both packages
  fs.writeFileSync(
    path.join(dir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'monorepo-root', private: true }),
  );

  // Optional root manifest listing both — informational, the dispatcher
  // doesn't read this file (yet); just shows the intended top-level shape.
  fs.mkdirSync(path.join(dir, '.autopilot'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.autopilot', 'manifest.yaml'),
    "schema_version: 1\nworkspaces:\n  - packages/web\n  - packages/api\n",
  );

  const webDir = path.join(dir, 'packages', 'web');
  const apiDir = path.join(dir, 'packages', 'api');
  fs.mkdirSync(webDir, { recursive: true });
  fs.mkdirSync(apiDir, { recursive: true });

  setupPrismaWorkspace(webDir);
  setupSupabaseWorkspace(apiDir);

  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'monorepo fixture'], { cwd: dir });

  return { repoRoot: dir, webDir, apiDir };
}

describe('integration: monorepo mixed-skill', () => {
  it('findWorkspaces discovers both packages and per-workspace dispatch isolates audit logs', async () => {
    await withCleanCIEnv(async () => {
      const { repoRoot, webDir, apiDir } = setupMonorepo();
      try {
        // 1. findWorkspaces finds both packages/web and packages/api
        const workspaces = findWorkspaces(repoRoot);
        const realWeb = fs.realpathSync(webDir);
        const realApi = fs.realpathSync(apiDir);
        const realWorkspaces = workspaces.map(w => fs.realpathSync(w));
        assert.ok(
          realWorkspaces.includes(realWeb),
          `findWorkspaces missing packages/web: ${JSON.stringify(realWorkspaces)}`,
        );
        assert.ok(
          realWorkspaces.includes(realApi),
          `findWorkspaces missing packages/api: ${JSON.stringify(realWorkspaces)}`,
        );

        // 2. Dispatch each workspace independently — each acts as its own
        //    repoRoot for stack.md, aliases, audit.log resolution.
        const webResult = await dispatch({
          repoRoot: webDir,
          env: 'dev',
          yesFlag: false,
          nonInteractive: true,
          currentRuntimeVersion: '5.2.0',
        });
        const apiResult = await dispatch({
          repoRoot: apiDir,
          env: 'dev',
          yesFlag: false,
          nonInteractive: true,
          currentRuntimeVersion: '5.2.0',
        });

        // 3. Each workspace resolved the correct skill
        assert.equal(webResult.status, 'applied', `web: ${webResult.reasonCode}`);
        assert.equal(webResult.skillId, 'migrate@1');
        assert.deepEqual(webResult.appliedMigrations, ['20260429_init.sql']);

        assert.equal(apiResult.status, 'applied', `api: ${apiResult.reasonCode}`);
        assert.equal(apiResult.skillId, 'migrate.supabase@1');
        assert.deepEqual(apiResult.appliedMigrations, ['20260429000000_init.sql']);
        assert.ok(
          apiResult.sideEffectsPerformed.includes('migration-ledger-updated'),
          'api workspace must emit supabase ledger side-effect',
        );

        // 4. Audit logs are isolated per workspace — neither workspace
        //    leaked entries into the other or into the root .autopilot/.
        const webAudit = path.join(webDir, '.autopilot', 'audit.log');
        const apiAudit = path.join(apiDir, '.autopilot', 'audit.log');
        const rootAudit = path.join(repoRoot, '.autopilot', 'audit.log');

        assert.ok(fs.existsSync(webAudit), 'web workspace missing audit.log');
        assert.ok(fs.existsSync(apiAudit), 'api workspace missing audit.log');
        assert.ok(!fs.existsSync(rootAudit), 'no audit.log should leak to repo root');

        const webEntry = JSON.parse(
          fs.readFileSync(webAudit, 'utf8').trim().split('\n')[0]!,
        );
        const apiEntry = JSON.parse(
          fs.readFileSync(apiAudit, 'utf8').trim().split('\n')[0]!,
        );

        assert.equal(webEntry.requested_skill, 'migrate@1');
        assert.equal(webEntry.resolved_skill, 'migrate@1');
        assert.equal(webEntry.result_status, 'applied');

        assert.equal(apiEntry.requested_skill, 'migrate.supabase@1');
        assert.equal(apiEntry.resolved_skill, 'migrate.supabase@1');
        assert.equal(apiEntry.result_status, 'applied');

        // Cross-check: invocation IDs differ — each dispatch built its own envelope
        assert.notEqual(webEntry.invocationId, apiEntry.invocationId);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });
});
