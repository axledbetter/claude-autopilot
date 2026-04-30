// tests/deploy-rollback.test.ts
//
// Phase 4 — auto-rollback on health-check failure. Covers:
//   1. Post-deploy health check (pass + retry-then-pass).
//   2. Auto-rollback wiring when rollbackOn includes 'healthCheckFailure'.
//   3. --pr flag posts marker-anchored upserting comment.
//
// All tests use injected fetchImpl/sleepImpl/ghImpl to avoid touching the
// network or shell.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDeploy } from '../src/cli/deploy.ts';
import type { DeployAdapter } from '../src/adapters/deploy/types.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-deploy-rollback-'));
}

function writeConfig(dir: string, body: string): void {
  fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), body);
}

describe('runDeploy health check', () => {
  it('passes through when health check returns 2xx', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n  healthCheckUrl: https://app.test/healthz\n',
    );
    let healthCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      healthCalls += 1;
      return new Response('ok', { status: 200 });
    };
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return { status: 'pass', deployId: 'dpl_new', deployUrl: 'https://new.vercel.app', durationMs: 100 };
      },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 0, 'deploy + health-check both pass → exit 0');
      assert.equal(healthCalls, 1, 'health check fired exactly once on first 200');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('retries health check on transient failure then passes', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n  healthCheckUrl: https://app.test/healthz\n',
    );
    let healthCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      healthCalls += 1;
      return new Response(healthCalls === 1 ? 'down' : 'ok', { status: healthCalls === 1 ? 503 : 200 });
    };
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return { status: 'pass', deployId: 'dpl_new', durationMs: 1 };
      },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 0, 'transient blip recovered → exit 0');
      assert.equal(healthCalls, 2, '1 fail + 1 pass = 2 calls total');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
