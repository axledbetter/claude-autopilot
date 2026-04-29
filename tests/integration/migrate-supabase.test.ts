// Integration test: Supabase stack.md → dispatcher → result artifact + audit log.
//
// Same end-to-end shape as migrate-prisma.test.ts but exercises the
// migrate.supabase@1 stable ID + supabase{} schema block, with a fake
// runner that emits the side-effect set we expect from the supabase
// adapter: ['migration-ledger-updated', 'types-regenerated'].
//
// What this test verifies on top of the prisma case:
//   - migrate.supabase@1 alias resolves to skills/migrate-supabase/
//   - the schema's `if skill==migrate.supabase@1 then required: supabase{
//     deltas_dir, types_out, envs_file }` rule is satisfied (validation
//     passes)
//   - skills/migrate-supabase/skill.manifest.json handshake succeeds
//   - the result includes migration-ledger-updated as a side-effect

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dispatch } from '../../src/core/migrate/dispatcher.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_RUNNER = path.resolve(__dirname, '../fixtures/integration/supabase-fixture/fake-runner.js');

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

function setupSupabaseRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supabase-int-'));

  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'a'], { cwd: dir });

  // Supabase-shaped tree: data/deltas/, types/supabase.ts, envs file
  fs.mkdirSync(path.join(dir, 'data', 'deltas'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'data', 'deltas', '20260429000000_init.sql'),
    '-- supabase migration\n',
  );
  fs.mkdirSync(path.join(dir, 'types'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'types', 'supabase.ts'), '// generated\n');
  fs.writeFileSync(path.join(dir, '.env.dev'), 'SUPABASE_PROJECT_REF=local\n');

  // Alias map
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'presets', 'aliases.lock.json'), JSON.stringify({
    schemaVersion: 1,
    aliases: [
      { stableId: 'migrate.supabase@1', resolvesTo: 'skills/migrate-supabase/', rawAliases: ['migrate-supabase'] },
    ],
  }));

  // Skill manifest under the resolvesTo directory
  const skillDir = path.join(dir, 'skills', 'migrate-supabase');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# migrate-supabase');
  fs.writeFileSync(path.join(skillDir, 'skill.manifest.json'), JSON.stringify({
    skillId: 'migrate.supabase@1',
    skill_runtime_api_version: '1.0',
    min_runtime: '5.0.0',
    max_runtime: '5.x',
  }));

  // Fake runner — workspace-relative path so the schema's no-metachar rule passes
  fs.copyFileSync(FIXTURE_RUNNER, path.join(dir, 'fake-runner.js'));

  // stack.md — supabase block satisfies the schema's conditional `if/then`,
  // envs.dev gives the dispatcher a command to spawn.
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
  fs.mkdirSync(path.join(dir, '.autopilot'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.autopilot', 'stack.md'), stackMd);

  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: dir });

  return dir;
}

describe('integration: migrate-supabase fixture', () => {
  it('dispatch dev → applied result with migration-ledger-updated side-effect', async () => {
    await withCleanCIEnv(async () => {
      const repo = setupSupabaseRepo();
      try {
        const result = await dispatch({
          repoRoot: repo,
          env: 'dev',
          yesFlag: false,
          nonInteractive: true,
          currentRuntimeVersion: '5.2.0',
        });

        assert.equal(result.status, 'applied', `expected applied, got ${result.status}: ${result.reasonCode}`);
        assert.equal(result.skillId, 'migrate.supabase@1');
        assert.equal(result.reasonCode, 'ok');
        assert.deepEqual(result.appliedMigrations, ['20260429000000_init.sql']);
        // Supabase-specific signature: ledger updated AND types regenerated
        assert.ok(
          result.sideEffectsPerformed.includes('migration-ledger-updated'),
          'supabase result must include migration-ledger-updated',
        );
        assert.ok(
          result.sideEffectsPerformed.includes('types-regenerated'),
          'supabase result must include types-regenerated',
        );
        assert.equal(result.destructiveDetected, false);

        const auditLog = path.join(repo, '.autopilot', 'audit.log');
        assert.ok(fs.existsSync(auditLog));
        const entry = JSON.parse(
          fs.readFileSync(auditLog, 'utf8').trim().split('\n')[0]!,
        );
        assert.equal(entry.requested_skill, 'migrate.supabase@1');
        assert.equal(entry.resolved_skill, 'migrate.supabase@1');
        assert.equal(entry.result_status, 'applied');
        // resolveSkill realpath-canonicalizes the skill path; just assert it
        // points at the supabase skill directory (without depending on trailing slash).
        assert.match(entry.skill_path, /skills[/\\]migrate-supabase\/?$/);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
