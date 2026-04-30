import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { enforcePolicy, type PolicyConfig, type EnforcementContext } from '../../src/core/migrate/policy-enforcer.ts';

const ORIGINAL_ENV = { ...process.env };
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
  }
}

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pol-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'a@b.c'], dir);
  git(['config', 'user.name', 'a'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  git(['add', '.'], dir);
  git(['commit', '-qm', 'initial'], dir);
  return dir;
}

function defaultPolicy(): PolicyConfig {
  return {
    allow_prod_in_ci: false,
    require_clean_git: true,
    require_manual_approval: true,
    require_dry_run_first: false,
  };
}

describe('enforcePolicy — allow_prod_in_ci (4-flag CI prod gate)', () => {
  it('blocks env=prod in CI when allow_prod_in_ci=false (default)', () => {
    withEnv({ GITHUB_ACTIONS: 'true', CI: 'true' }, () => {
      const repo = makeRepo();
      const r = enforcePolicy({
        policy: defaultPolicy(),
        env: 'prod',
        repoRoot: repo,
        ci: true,
        yesFlag: true,
        nonInteractive: true,
        gitHead: 'a'.repeat(40),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reasonCode, 'prod-blocked-by-policy');
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('allows env=prod in CI with all 4 flags + provider env', () => {
    withEnv({
      GITHUB_ACTIONS: 'true',
      CI: 'true',
      AUTOPILOT_CI_POLICY: 'allow-prod',
      AUTOPILOT_TARGET_ENV: 'prod',
    }, () => {
      const repo = makeRepo();
      const r = enforcePolicy({
        policy: { ...defaultPolicy(), allow_prod_in_ci: true, require_clean_git: false, require_manual_approval: false },
        env: 'prod',
        repoRoot: repo,
        ci: true,
        yesFlag: true,
        nonInteractive: true,
        gitHead: 'a'.repeat(40),
      });
      assert.equal(r.ok, true, r.ok ? '' : `${r.reasonCode}: ${r.message}`);
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('rejects when AUTOPILOT_TARGET_ENV does not match --env', () => {
    withEnv({
      GITHUB_ACTIONS: 'true',
      CI: 'true',
      AUTOPILOT_CI_POLICY: 'allow-prod',
      AUTOPILOT_TARGET_ENV: 'staging',
    }, () => {
      const repo = makeRepo();
      const r = enforcePolicy({
        policy: { ...defaultPolicy(), allow_prod_in_ci: true, require_clean_git: false, require_manual_approval: false },
        env: 'prod',
        repoRoot: repo,
        ci: true,
        yesFlag: true,
        nonInteractive: true,
        gitHead: 'a'.repeat(40),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reasonCode, 'target-env-mismatch');
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('rejects when AUTOPILOT_CI_POLICY missing', () => {
    withEnv({
      GITHUB_ACTIONS: 'true',
      CI: 'true',
      AUTOPILOT_TARGET_ENV: 'prod',
    }, () => {
      const repo = makeRepo();
      const r = enforcePolicy({
        policy: { ...defaultPolicy(), allow_prod_in_ci: true, require_clean_git: false, require_manual_approval: false },
        env: 'prod',
        repoRoot: repo,
        ci: true,
        yesFlag: true,
        nonInteractive: true,
        gitHead: 'a'.repeat(40),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reasonCode, 'ci-policy-missing');
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('rejects when --yes flag is missing in CI', () => {
    withEnv({
      GITHUB_ACTIONS: 'true',
      CI: 'true',
      AUTOPILOT_CI_POLICY: 'allow-prod',
      AUTOPILOT_TARGET_ENV: 'prod',
    }, () => {
      const repo = makeRepo();
      const r = enforcePolicy({
        policy: { ...defaultPolicy(), allow_prod_in_ci: true, require_clean_git: false, require_manual_approval: false },
        env: 'prod',
        repoRoot: repo,
        ci: true,
        yesFlag: false,
        nonInteractive: true,
        gitHead: 'a'.repeat(40),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reasonCode, 'yes-flag-missing');
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('rejects in CI when no recognized provider env (CI=true alone)', () => {
    withEnv({
      CI: 'true',
      GITHUB_ACTIONS: undefined,
      GITLAB_CI: undefined,
      CIRCLECI: undefined,
      BUILDKITE: undefined,
      JENKINS_URL: undefined,
      AUTOPILOT_CI_POLICY: 'allow-prod',
      AUTOPILOT_TARGET_ENV: 'prod',
    }, () => {
      const repo = makeRepo();
      const r = enforcePolicy({
        policy: { ...defaultPolicy(), allow_prod_in_ci: true, require_clean_git: false, require_manual_approval: false },
        env: 'prod',
        repoRoot: repo,
        ci: true,
        yesFlag: true,
        nonInteractive: true,
        gitHead: 'a'.repeat(40),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reasonCode, 'no-recognized-ci-provider');
      fs.rmSync(repo, { recursive: true });
    });
  });

  it('honors AUTOPILOT_CI_PROVIDER override', () => {
    withEnv({
      CI: 'true',
      AUTOPILOT_CI_PROVIDER: 'self-hosted',
      AUTOPILOT_CI_POLICY: 'allow-prod',
      AUTOPILOT_TARGET_ENV: 'prod',
    }, () => {
      const repo = makeRepo();
      const r = enforcePolicy({
        policy: { ...defaultPolicy(), allow_prod_in_ci: true, require_clean_git: false, require_manual_approval: false },
        env: 'prod',
        repoRoot: repo,
        ci: true,
        yesFlag: true,
        nonInteractive: true,
        gitHead: 'a'.repeat(40),
      });
      assert.equal(r.ok, true, r.ok ? '' : `${r.reasonCode}: ${r.message}`);
      fs.rmSync(repo, { recursive: true });
    });
  });
});

describe('enforcePolicy — require_clean_git', () => {
  it('passes on clean working tree', () => {
    const repo = makeRepo();
    const r = enforcePolicy({
      policy: { ...defaultPolicy(), require_manual_approval: false },
      env: 'dev',
      repoRoot: repo,
      ci: false,
      yesFlag: true,
      nonInteractive: true,
      gitHead: 'a'.repeat(40),
    });
    assert.equal(r.ok, true, r.ok ? '' : r.reasonCode);
    fs.rmSync(repo, { recursive: true });
  });

  it('rejects when there are uncommitted changes', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'b.txt'), 'dirty');
    const r = enforcePolicy({
      policy: { ...defaultPolicy(), require_manual_approval: false },
      env: 'dev',
      repoRoot: repo,
      ci: false,
      yesFlag: true,
      nonInteractive: true,
      gitHead: 'a'.repeat(40),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'unclean-git');
    fs.rmSync(repo, { recursive: true });
  });
});

describe('enforcePolicy — require_dry_run_first', () => {
  it('rejects when no prior dry-run artifact for gitHead+env', () => {
    const repo = makeRepo();
    const r = enforcePolicy({
      policy: { ...defaultPolicy(), require_manual_approval: false, require_dry_run_first: true },
      env: 'staging',
      repoRoot: repo,
      ci: false,
      yesFlag: true,
      nonInteractive: true,
      gitHead: 'abc123',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'no-prior-dry-run');
    fs.rmSync(repo, { recursive: true });
  });

  it('passes when dry-run artifact exists at .autopilot/dry-runs/<gitHead>-<env>.json', () => {
    const repo = makeRepo();
    const dryRunsDir = path.join(repo, '.autopilot', 'dry-runs');
    fs.mkdirSync(dryRunsDir, { recursive: true });
    fs.writeFileSync(path.join(dryRunsDir, 'abc123-staging.json'), JSON.stringify({ ok: true }));
    const r = enforcePolicy({
      // require_clean_git disabled because writing the dry-run artifact above leaves the
      // working tree with an untracked file, which would otherwise block on the clean-git check
      // before we reach the dry-run check this test is verifying.
      policy: { ...defaultPolicy(), require_clean_git: false, require_manual_approval: false, require_dry_run_first: true },
      env: 'staging',
      repoRoot: repo,
      ci: false,
      yesFlag: true,
      nonInteractive: true,
      gitHead: 'abc123',
    });
    assert.equal(r.ok, true, r.ok ? '' : `${r.reasonCode}: ${r.message}`);
    fs.rmSync(repo, { recursive: true });
  });
});

describe('enforcePolicy — require_manual_approval (interactive only)', () => {
  it('skips approval check when env=dev', () => {
    const repo = makeRepo();
    const r = enforcePolicy({
      policy: defaultPolicy(),
      env: 'dev',
      repoRoot: repo,
      ci: false,
      yesFlag: true,
      nonInteractive: true,
      gitHead: 'a'.repeat(40),
    });
    assert.equal(r.ok, true);
    fs.rmSync(repo, { recursive: true });
  });

  it('blocks non-dev env with require_manual_approval=true and nonInteractive=true (no way to ask)', () => {
    const repo = makeRepo();
    const r = enforcePolicy({
      policy: { ...defaultPolicy(), require_clean_git: false },
      env: 'staging',
      repoRoot: repo,
      ci: false,
      yesFlag: false,
      nonInteractive: true,
      gitHead: 'a'.repeat(40),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'manual-approval-required');
    fs.rmSync(repo, { recursive: true });
  });

  it('passes non-dev env when --yes flag is set even with require_manual_approval=true', () => {
    const repo = makeRepo();
    const r = enforcePolicy({
      policy: { ...defaultPolicy(), require_clean_git: false },
      env: 'staging',
      repoRoot: repo,
      ci: false,
      yesFlag: true,
      nonInteractive: true,
      gitHead: 'a'.repeat(40),
    });
    assert.equal(r.ok, true);
    fs.rmSync(repo, { recursive: true });
  });
});
