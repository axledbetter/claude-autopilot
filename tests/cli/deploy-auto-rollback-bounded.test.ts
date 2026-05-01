// tests/cli/deploy-auto-rollback-bounded.test.ts
//
// Phase 4 of v5.6 — bounded auto-rollback at the CLI orchestration layer.
//
// The v5.6 spec § "Health-check policy" mandates exactly one auto-rollback
// per deploy attempt (no chains) and introduces two terminal status values
// on `DeployResult`:
//
//   - `fail_rolled_back`     — deploy passed, health check failed, rollback OK
//   - `fail_rollback_failed` — deploy passed, health check failed, rollback ALSO failed
//
// These tests pin both behaviors against the existing `runDeploy` runner,
// reusing the same test seams as `tests/deploy-rollback.test.ts`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDeploy } from '../../src/cli/deploy.ts';
import type { DeployAdapter } from '../../src/adapters/deploy/types.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-deploy-bounded-rollback-'));
}

const ROLLBACK_CONFIG = [
  'configVersion: 1',
  'deploy:',
  '  adapter: vercel',
  '  project: my-app',
  '  healthCheckUrl: https://app.test/healthz',
  '  rollbackOn:',
  '    - healthCheckFailure',
  '',
].join('\n');

describe('runDeploy — bounded auto-rollback (v5.6 Phase 4)', () => {
  it('auto-rollback fires AT MOST ONCE per deploy attempt (no chains)', async () => {
    // Both deploy and rollback report pass — the crucial invariant is the
    // CLI doesn't loop after rollback returns, even if the rolled-back
    // target is itself unhealthy.
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), ROLLBACK_CONFIG);
    let rollbackCalls = 0;
    let healthCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      healthCalls += 1;
      // Always-failing health: would loop forever if the CLI re-tried after
      // rollback. The bound MUST cap at exactly one rollback.
      return new Response('still down', { status: 503 });
    };
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return { status: 'pass', deployId: 'dpl_new', durationMs: 1 };
      },
      async rollback() {
        rollbackCalls += 1;
        return {
          status: 'pass',
          deployId: 'dpl_prev',
          rolledBackTo: 'dpl_prev',
          durationMs: 1,
        };
      },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1, 'health-check + rollback case exits 1');
      assert.equal(rollbackCalls, 1, 'rollback fired exactly once — no chain');
      // Health check ran the spec's 5 attempts (5x with 6s backoff). It
      // MUST NOT re-run after rollback completes.
      assert.equal(healthCalls, 5, 'health check capped at 5 attempts (spec budget)');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('result.status maps to fail_rolled_back when rollback succeeds', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), ROLLBACK_CONFIG);
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    let observedStatus: string | undefined;
    // Capture the status we print by intercepting console.log — the runner's
    // own `printResult` echoes `status=...`, which is the same string we
    // assert on for downstream consumers (PR comment formatter, exit code
    // mapping).
    const stdoutLines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => stdoutLines.push(msg);
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return { status: 'pass', deployId: 'dpl_new', durationMs: 1 };
      },
      async rollback() {
        return {
          status: 'pass',
          deployId: 'dpl_prev',
          rolledBackTo: 'dpl_prev',
          durationMs: 1,
        };
      },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1, 'fail_rolled_back still exits 1 (deploy outcome was a failure)');
      const all = stdoutLines.join('\n');
      observedStatus = all;
      assert.match(all, /status=fail_rolled_back/, `expected fail_rolled_back marker; got: ${all}`);
      assert.match(all, /auto-rolled-back-to=dpl_prev/);
    } finally {
      console.log = origLog;
      fs.rmSync(dir, { recursive: true });
    }
    void observedStatus;
  });

  it('result.status maps to fail_rollback_failed when rollback throws', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), ROLLBACK_CONFIG);
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg: string) => stdoutLines.push(msg);
    console.error = (msg: string) => stderrLines.push(msg);
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return { status: 'pass', deployId: 'dpl_new', durationMs: 1 };
      },
      async rollback() {
        throw new Error('Fly returned 401 — token expired mid-rollback');
      },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1);
      const allOut = [...stdoutLines, ...stderrLines].join('\n');
      assert.match(
        allOut,
        /status=fail_rollback_failed/,
        `expected fail_rollback_failed marker; got: ${allOut}`,
      );
      assert.match(allOut, /auto-rollback FAILED|auto-rollback ERRORED/i);
    } finally {
      console.log = origLog;
      console.error = origErr;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('result.status maps to fail_rollback_failed when rollback returns non-pass', async () => {
    // Adapter doesn't throw, but its rollback returns `in-progress` or
    // `fail` — equally a failure mode the CLI must surface as
    // fail_rollback_failed (not plain `fail`, which would lose the "we
    // tried to roll back" signal).
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), ROLLBACK_CONFIG);
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    const stdoutLines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => stdoutLines.push(msg);
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return { status: 'pass', deployId: 'dpl_new', durationMs: 1 };
      },
      async rollback() {
        return {
          status: 'in-progress',
          deployId: 'dpl_prev',
          durationMs: 1,
          output: 'rollback timed out',
        };
      },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1);
      const all = stdoutLines.join('\n');
      assert.match(all, /status=fail_rollback_failed/);
    } finally {
      console.log = origLog;
      fs.rmSync(dir, { recursive: true });
    }
  });
});
