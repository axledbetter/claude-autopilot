import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatch } from '../../src/core/migrate/dispatcher.ts';

const ORIGINAL_ENV = { ...process.env };
function withCleanCIEnv<T>(fn: () => Promise<T> | T): Promise<T> | T {
  // Strip CI-related vars so detectCI() returns ci:false in tests by default,
  // unless the test specifically wants CI behaviour.
  const stripped = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'BUILDKITE', 'JENKINS_URL', 'AUTOPILOT_CI_PROVIDER', 'AUTOPILOT_CI_POLICY', 'AUTOPILOT_TARGET_ENV', 'GITHUB_RUN_ID'];
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

function makeRepoWithStackMd(stackMd: string, opts: { skills?: Record<string, { skillJson?: object }> } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'a'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'initial'], { cwd: dir });

  // .autopilot/stack.md
  fs.mkdirSync(path.join(dir, '.autopilot'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.autopilot', 'stack.md'), stackMd);

  // presets/aliases.lock.json — minimal (lives under repoRoot for resolveSkill)
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'presets', 'aliases.lock.json'), JSON.stringify({
    schemaVersion: 1,
    aliases: [
      { stableId: 'migrate@1', resolvesTo: 'skills/migrate/', rawAliases: ['migrate'] },
      { stableId: 'none@1', resolvesTo: 'skills/migrate-none/', rawAliases: ['none', 'skip'] },
    ],
  }));

  // skills/<name>/skill.manifest.json
  for (const [skillName, cfg] of Object.entries(opts.skills ?? {})) {
    const skillDir = path.join(dir, 'skills', skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# ' + skillName);
    const manifest = cfg.skillJson ?? {
      skillId: skillName === 'migrate' ? 'migrate@1' : `${skillName}@1`,
      skill_runtime_api_version: '1.0',
      min_runtime: '5.0.0',
      max_runtime: '5.x',
    };
    fs.writeFileSync(path.join(skillDir, 'skill.manifest.json'), JSON.stringify(manifest));
  }

  // commit everything for clean-git policy
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'setup'], { cwd: dir });

  return dir;
}

// Note: the schema rejects shell metachars (|;&<>`$()) in command args, so
// we use --version (no metachars) rather than -e "console.log(...)".
const VALID_STACK_MD = `
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "node", args: ["--version"] }
  policy:
    allow_prod_in_ci: false
    require_clean_git: false
    require_manual_approval: false
    require_dry_run_first: false
`;

describe('dispatch — happy path', () => {
  it('happy path: stack.md → resolve → handshake → policy → execute → audit log entry', async () => {
    await withCleanCIEnv(async () => {
      const repo = makeRepoWithStackMd(VALID_STACK_MD, {
        skills: { migrate: {} },
      });
      await dispatch({
        repoRoot: repo,
        env: 'dev',
        yesFlag: false,
        nonInteractive: true,
        currentRuntimeVersion: '5.2.0',
      });
      // Status will be 'error' because the test skill doesn't write a real
      // ResultArtifact — but we want to verify the dispatcher made it through
      // resolve + handshake + policy without short-circuiting.
      // The audit log should still record the dispatch.
      const auditLog = path.join(repo, '.autopilot', 'audit.log');
      assert.ok(fs.existsSync(auditLog), 'audit log written');
      const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n');
      assert.ok(lines.length >= 1);
      const entry = JSON.parse(lines[0]!);
      assert.equal(entry.requested_skill, 'migrate@1');
      assert.equal(entry.resolved_skill, 'migrate@1');
      fs.rmSync(repo, { recursive: true });
    });
  });
});

describe('dispatch — fail-closed paths', () => {
  it('schema invalid → returns error before subprocess', async () => {
    await withCleanCIEnv(async () => {
      const repo = makeRepoWithStackMd(`
schema_version: 1
migrate:
  skill: "unknown@99"
`, { skills: { migrate: {} } });
      const result = await dispatch({
        repoRoot: repo,
        env: 'dev',
        yesFlag: false,
        nonInteractive: true,
        currentRuntimeVersion: '5.2.0',
      });
      assert.equal(result.status, 'error');
      assert.match(result.reasonCode, /invalid-stack-config|stable-id|schema/i);
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('skill missing on disk → fail-closed with traceable error', async () => {
    await withCleanCIEnv(async () => {
      // Stack.md references migrate@1 but skills/migrate/ doesn't exist
      const repo = makeRepoWithStackMd(VALID_STACK_MD); // no skills dir
      const result = await dispatch({
        repoRoot: repo,
        env: 'dev',
        yesFlag: false,
        nonInteractive: true,
        currentRuntimeVersion: '5.2.0',
      });
      assert.equal(result.status, 'error');
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('runtime below skill min_runtime → handshake rejection', async () => {
    await withCleanCIEnv(async () => {
      const repo = makeRepoWithStackMd(VALID_STACK_MD, {
        skills: {
          migrate: {
            skillJson: {
              skillId: 'migrate@1',
              skill_runtime_api_version: '1.0',
              min_runtime: '99.0.0',
              max_runtime: '99.x',
            },
          },
        },
      });
      const result = await dispatch({
        repoRoot: repo,
        env: 'dev',
        yesFlag: false,
        nonInteractive: true,
        currentRuntimeVersion: '5.2.0',
      });
      assert.equal(result.status, 'error');
      assert.equal(result.reasonCode, 'runtime-below-min');
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('policy violation → no command execution', async () => {
    await withCleanCIEnv(async () => {
      const repo = makeRepoWithStackMd(`
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "node", args: ["--version"] }
    prod:
      command: { exec: "echo", args: ["prod-marker"] }
      env_file: ".env.prod"
  policy:
    allow_prod_in_ci: false
    require_clean_git: false
    require_manual_approval: true
    require_dry_run_first: false
`, { skills: { migrate: {} } });
      const result = await dispatch({
        repoRoot: repo,
        env: 'prod',
        yesFlag: false,
        nonInteractive: true,
        currentRuntimeVersion: '5.2.0',
      });
      assert.equal(result.status, 'error');
      assert.match(result.reasonCode, /manual-approval|prod/i);
      fs.rmSync(repo, { recursive: true });
    });
  });
});

describe('dispatch — audit log emission', () => {
  it('emits an audit entry for every dispatch (success or failure)', async () => {
    await withCleanCIEnv(async () => {
      const repo = makeRepoWithStackMd(VALID_STACK_MD, { skills: { migrate: {} } });
      await dispatch({
        repoRoot: repo,
        env: 'dev',
        yesFlag: false,
        nonInteractive: true,
        currentRuntimeVersion: '5.2.0',
      });
      await dispatch({
        repoRoot: repo,
        env: 'dev',
        yesFlag: false,
        nonInteractive: true,
        currentRuntimeVersion: '5.2.0',
      });
      const lines = fs.readFileSync(path.join(repo, '.autopilot', 'audit.log'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('audit log entries have monotonic seq with valid prev_hash chain', async () => {
    await withCleanCIEnv(async () => {
      const repo = makeRepoWithStackMd(VALID_STACK_MD, { skills: { migrate: {} } });
      await dispatch({
        repoRoot: repo, env: 'dev', yesFlag: false, nonInteractive: true, currentRuntimeVersion: '5.2.0',
      });
      await dispatch({
        repoRoot: repo, env: 'dev', yesFlag: false, nonInteractive: true, currentRuntimeVersion: '5.2.0',
      });
      const { verifyChain } = await import('../../src/core/migrate/audit-log.ts');
      const r = verifyChain(path.join(repo, '.autopilot', 'audit.log'));
      assert.equal(r.valid, true);
      fs.rmSync(repo, { recursive: true });
    });
  });
});
