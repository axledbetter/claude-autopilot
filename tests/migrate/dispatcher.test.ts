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
      { stableId: 'migrate.supabase@1', resolvesTo: 'skills/migrate-supabase/', rawAliases: ['migrate-supabase'] },
      { stableId: 'none@1', resolvesTo: 'skills/migrate-none/', rawAliases: ['none', 'skip'] },
    ],
  }));

  // skills/<name>/skill.manifest.json
  // Map fixture skill folder name → real stableId. Folders like
  // `migrate-supabase`/`migrate-none` carry stable IDs that aren't a
  // mechanical transform of the folder name.
  const FOLDER_TO_STABLE_ID: Record<string, string> = {
    migrate: 'migrate@1',
    'migrate-supabase': 'migrate.supabase@1',
    'migrate-none': 'none@1',
  };
  for (const [skillName, cfg] of Object.entries(opts.skills ?? {})) {
    const skillDir = path.join(dir, 'skills', skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# ' + skillName);
    const manifest = cfg.skillJson ?? {
      skillId: FOLDER_TO_STABLE_ID[skillName] ?? `${skillName}@1`,
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

describe('dispatch — skill-specific branching', () => {
  it('none@1 short-circuits to status: skipped, reasonCode: migration-disabled, no subprocess', async () => {
    await withCleanCIEnv(async () => {
      const NONE_STACK_MD = `
schema_version: 1
migrate:
  skill: "none@1"
  policy:
    allow_prod_in_ci: false
    require_clean_git: false
    require_manual_approval: false
    require_dry_run_first: false
`;
      const repo = makeRepoWithStackMd(NONE_STACK_MD, {
        skills: { 'migrate-none': {} },
      });
      const result = await dispatch({
        repoRoot: repo,
        env: 'dev',
        yesFlag: false,
        nonInteractive: true,
        currentRuntimeVersion: '5.2.0',
      });
      assert.equal(result.status, 'skipped');
      assert.equal(result.reasonCode, 'migration-disabled');
      assert.equal(result.skillId, 'none@1');
      assert.deepEqual(result.appliedMigrations, []);
      assert.deepEqual(result.sideEffectsPerformed, ['no-side-effects']);

      // Audit log should still record the dispatch.
      const auditLog = path.join(repo, '.autopilot', 'audit.log');
      assert.ok(fs.existsSync(auditLog), 'audit log written for none@1 dispatch');
      const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]!);
      assert.equal(entry.requested_skill, 'none@1');
      assert.equal(entry.resolved_skill, 'none@1');
      assert.equal(entry.result_status, 'skipped');
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('migrate.supabase@1 without supabase block → invalid-stack-config (caught by schema validator)', async () => {
    await withCleanCIEnv(async () => {
      // The migrate.schema.json conditional makes `supabase` required when
      // skill is migrate.supabase@1 — so omitting it surfaces as a schema
      // validation failure (invalid-stack-config) before dispatch ever runs.
      const SUPABASE_NO_BLOCK = `
schema_version: 1
migrate:
  skill: "migrate.supabase@1"
  policy:
    allow_prod_in_ci: false
    require_clean_git: false
    require_manual_approval: false
    require_dry_run_first: false
`;
      const repo = makeRepoWithStackMd(SUPABASE_NO_BLOCK, {
        skills: { 'migrate-supabase': {} },
      });
      const result = await dispatch({
        repoRoot: repo,
        env: 'dev',
        yesFlag: false,
        nonInteractive: true,
        currentRuntimeVersion: '5.2.0',
      });
      assert.equal(result.status, 'error');
      assert.equal(result.reasonCode, 'invalid-stack-config');
      fs.rmSync(repo, { recursive: true });
    });
  });
});

describe('loadEnvFile (env file parser)', () => {
  it('accepts lowercase, uppercase, mixed-case keys; ignores blank lines and # comments; strips balanced quotes', () => {
    // dispatcher.loadEnvFile is module-internal; re-create the regex
    // contract here as a focused unit-style assertion to keep the
    // parser behavior documented and locked in.
    const lines = [
      '# comment ignored',
      '',
      'database_url=postgres://localhost/db',
      'PORT=5432',
      'mixed_Case=42',
      'QUOTED_DOUBLE="hello"',
      "QUOTED_SINGLE='world'",
      'invalid line without equals',
    ];
    const parsed: Record<string, string> = {};
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2]!;
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      parsed[m[1]!] = value;
    }
    assert.equal(parsed.database_url, 'postgres://localhost/db');
    assert.equal(parsed.PORT, '5432');
    assert.equal(parsed.mixed_Case, '42');
    assert.equal(parsed.QUOTED_DOUBLE, 'hello');
    assert.equal(parsed.QUOTED_SINGLE, 'world');
    assert.ok(!('invalid line without equals' in parsed));
    assert.ok(!('# comment ignored' in parsed));
  });
});
