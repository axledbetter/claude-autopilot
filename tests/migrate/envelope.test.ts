// tests/migrate/envelope.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildEnvelope, detectCI } from '../../src/core/migrate/envelope.ts';

const TEST_REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

describe('buildEnvelope', () => {
  it('returns an envelope with all required fields', () => {
    const env = buildEnvelope({
      changedFiles: ['data/deltas/foo.sql'],
      env: 'dev',
      repoRoot: TEST_REPO_ROOT,
    });
    assert.equal(env.contractVersion, '1.0');
    assert.equal(env.env, 'dev');
    assert.equal(env.dryRun, false);
    assert.equal(env.attempt, 1);
    assert.deepEqual(env.changedFiles, ['data/deltas/foo.sql']);
    assert.equal(env.repoRoot, TEST_REPO_ROOT);
    assert.ok(['cli', 'ci'].includes(env.trigger));
  });

  it('generates a unique invocationId per call (UUID v4 format)', () => {
    const e1 = buildEnvelope({ changedFiles: [], env: 'dev', repoRoot: TEST_REPO_ROOT });
    const e2 = buildEnvelope({ changedFiles: [], env: 'dev', repoRoot: TEST_REPO_ROOT });
    assert.notEqual(e1.invocationId, e2.invocationId);
    // UUID v4 pattern
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.match(e1.invocationId, uuidRe);
  });

  it('generates a unique 64-hex-char nonce per call (32 bytes)', () => {
    const e1 = buildEnvelope({ changedFiles: [], env: 'dev', repoRoot: TEST_REPO_ROOT });
    const e2 = buildEnvelope({ changedFiles: [], env: 'dev', repoRoot: TEST_REPO_ROOT });
    assert.notEqual(e1.nonce, e2.nonce);
    assert.match(e1.nonce, /^[0-9a-f]{64}$/);
    assert.match(e2.nonce, /^[0-9a-f]{64}$/);
  });

  it('reads gitBase and gitHead via git rev-parse', () => {
    const env = buildEnvelope({ changedFiles: [], env: 'dev', repoRoot: TEST_REPO_ROOT });
    assert.match(env.gitHead, /^[0-9a-f]{40}$/);
    assert.match(env.gitBase, /^[0-9a-f]{40}$/);
  });

  it('honors dryRun option', () => {
    const env = buildEnvelope({
      changedFiles: [],
      env: 'dev',
      repoRoot: TEST_REPO_ROOT,
      dryRun: true,
    });
    assert.equal(env.dryRun, true);
  });

  it('honors projectId option (monorepo)', () => {
    const env = buildEnvelope({
      changedFiles: [],
      env: 'dev',
      repoRoot: TEST_REPO_ROOT,
      projectId: 'packages/web',
    });
    assert.equal(env.projectId, 'packages/web');
  });

  it('throws if not in a git repo', () => {
    assert.throws(
      () => buildEnvelope({ changedFiles: [], env: 'dev', repoRoot: '/nonexistent-non-git-path' }),
      /not.*git|git.*repo|rev-parse/i,
    );
  });
});

describe('detectCI', () => {
  // Save and restore process.env for these tests
  const originalEnv = { ...process.env };
  function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
    // Reset to baseline before each scenario
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    // Apply scenario overrides
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      // Restore
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  }

  it('detects GitHub Actions', () => {
    withEnv({ GITHUB_ACTIONS: 'true', CI: 'true' }, () => {
      const r = detectCI();
      assert.equal(r.ci, true);
      assert.equal(r.provider, 'github-actions');
    });
  });

  it('detects GitLab CI', () => {
    withEnv({ GITLAB_CI: 'true', CI: 'true', GITHUB_ACTIONS: undefined }, () => {
      const r = detectCI();
      assert.equal(r.ci, true);
      assert.equal(r.provider, 'gitlab');
    });
  });

  it('detects CircleCI', () => {
    withEnv({ CIRCLECI: 'true', CI: 'true', GITHUB_ACTIONS: undefined, GITLAB_CI: undefined }, () => {
      const r = detectCI();
      assert.equal(r.ci, true);
      assert.equal(r.provider, 'circleci');
    });
  });

  it('detects Buildkite', () => {
    withEnv({ BUILDKITE: 'true', CI: 'true', GITHUB_ACTIONS: undefined, GITLAB_CI: undefined, CIRCLECI: undefined }, () => {
      const r = detectCI();
      assert.equal(r.ci, true);
      assert.equal(r.provider, 'buildkite');
    });
  });

  it('detects Jenkins via JENKINS_URL', () => {
    withEnv({ JENKINS_URL: 'https://j', CI: 'true', GITHUB_ACTIONS: undefined, GITLAB_CI: undefined, CIRCLECI: undefined, BUILDKITE: undefined }, () => {
      const r = detectCI();
      assert.equal(r.ci, true);
      assert.equal(r.provider, 'jenkins');
    });
  });

  it('honors AUTOPILOT_CI_PROVIDER override', () => {
    withEnv({ AUTOPILOT_CI_PROVIDER: 'self-hosted', CI: 'true' }, () => {
      const r = detectCI();
      assert.equal(r.ci, true);
      assert.equal(r.provider, 'self-hosted');
      assert.equal(r.overridden, true);
    });
  });

  it('returns ci=false when no CI signals present', () => {
    withEnv({ CI: undefined, GITHUB_ACTIONS: undefined, GITLAB_CI: undefined, CIRCLECI: undefined, BUILDKITE: undefined, JENKINS_URL: undefined, AUTOPILOT_CI_PROVIDER: undefined }, () => {
      const r = detectCI();
      assert.equal(r.ci, false);
      assert.equal(r.provider, null);
    });
  });

  it('CI=true alone (no provider marker) gives ci=true, provider=null (blocks prod gate)', () => {
    withEnv({ CI: 'true', GITHUB_ACTIONS: undefined, GITLAB_CI: undefined, CIRCLECI: undefined, BUILDKITE: undefined, JENKINS_URL: undefined, AUTOPILOT_CI_PROVIDER: undefined }, () => {
      const r = detectCI();
      assert.equal(r.ci, true);
      assert.equal(r.provider, null);
    });
  });
});
