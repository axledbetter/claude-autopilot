// Integration test: Prisma stack.md → dispatcher → result artifact + audit log.
//
// Uses a fake runner script (tests/fixtures/integration/prisma-fixture/fake-runner.js)
// in place of `prisma migrate deploy` so CI doesn't need a real Prisma binary.
// The runner reads $AUTOPILOT_ENVELOPE + $AUTOPILOT_RESULT_PATH the dispatcher
// sets in the child env and writes a ResultArtifact echoing the envelope identity.
//
// What this test verifies end-to-end:
//   - stack.md is read + schema-validated
//   - migrate@1 alias is resolved against presets/aliases.lock.json
//   - skill manifest handshake succeeds (runtime range)
//   - envelope is built with a real invocationId + nonce
//   - policy is enforced (dev env, all flags relaxed)
//   - the fake runner is spawned, reads the envelope, writes the result file
//   - the result is parsed and identity-checked
//   - the audit log captures the dispatch with status='applied'

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dispatch } from '../../src/core/migrate/dispatcher.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_RUNNER = path.resolve(__dirname, '../fixtures/integration/prisma-fixture/fake-runner.js');

const ORIGINAL_ENV = { ...process.env };
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

function setupPrismaRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-int-'));

  // Minimal git repo
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'a'], { cwd: dir });

  // Prisma-shaped tree
  fs.mkdirSync(path.join(dir, 'prisma', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), 'model User { id String @id }');
  fs.writeFileSync(path.join(dir, 'prisma', 'migrations', '20260429_init.sql'), '-- migration');

  // Alias map (must live under repoRoot — alias-resolver reads it from there)
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'presets', 'aliases.lock.json'), JSON.stringify({
    schemaVersion: 1,
    aliases: [
      { stableId: 'migrate@1', resolvesTo: 'skills/migrate/', rawAliases: ['migrate'] },
    ],
  }));

  // Minimal migrate skill (manifest is what the handshake reads)
  const skillDir = path.join(dir, 'skills', 'migrate');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# migrate');
  fs.writeFileSync(path.join(skillDir, 'skill.manifest.json'), JSON.stringify({
    skillId: 'migrate@1',
    skill_runtime_api_version: '1.0',
    min_runtime: '5.0.0',
    max_runtime: '5.x',
  }));

  // Copy the fake runner into the workspace so the schema-permitted ./fake-runner.js
  // path resolves. (The schema rejects shell metachars in args[], so we cannot
  // use `node -e "..."` inline.)
  fs.copyFileSync(FIXTURE_RUNNER, path.join(dir, 'fake-runner.js'));

  // stack.md — exec is `node`, args is `['./fake-runner.js']` (no metachars).
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
  fs.mkdirSync(path.join(dir, '.autopilot'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.autopilot', 'stack.md'), stackMd);

  // Commit so git refs resolve cleanly for the envelope.
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: dir });

  return dir;
}

describe('integration: migrate-prisma fixture', () => {
  it('dispatch dev → applied result + audit log entry', async () => {
    await withCleanCIEnv(async () => {
      const repo = setupPrismaRepo();
      try {
        const result = await dispatch({
          repoRoot: repo,
          env: 'dev',
          yesFlag: false,
          nonInteractive: true,
          currentRuntimeVersion: '5.2.0',
        });

        // Result artifact came from the fake runner via $AUTOPILOT_RESULT_PATH
        assert.equal(result.status, 'applied', `expected applied, got ${result.status}: ${result.reasonCode}`);
        assert.equal(result.skillId, 'migrate@1');
        assert.equal(result.reasonCode, 'ok');
        assert.deepEqual(result.appliedMigrations, ['20260429_init.sql']);
        assert.deepEqual(result.sideEffectsPerformed, ['types-regenerated']);
        assert.deepEqual(result.nextActions, ['regenerate-types']);
        assert.equal(result.destructiveDetected, false);

        // Audit log written with applied status and correct skill identity
        const auditLog = path.join(repo, '.autopilot', 'audit.log');
        assert.ok(fs.existsSync(auditLog), 'audit log written');
        const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n');
        assert.equal(lines.length, 1);
        const entry = JSON.parse(lines[0]!);
        assert.equal(entry.requested_skill, 'migrate@1');
        assert.equal(entry.resolved_skill, 'migrate@1');
        assert.equal(entry.result_status, 'applied');
        assert.equal(entry.mode, 'apply');
        assert.equal(entry.skill_runtime_api_version, '1.0');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
