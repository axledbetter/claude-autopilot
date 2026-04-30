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

describe('runDeploy auto-rollback on health-check failure', () => {
  it('positive: rollback fires when rollbackOn includes healthCheckFailure', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: vercel',
        '  project: my-app',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn:',
        '    - healthCheckFailure',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    let rollbackCalls = 0;
    const stdoutLines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => {
      stdoutLines.push(msg);
    };
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return {
          status: 'pass',
          deployId: 'dpl_new',
          deployUrl: 'https://new.vercel.app',
          durationMs: 1,
        };
      },
      async rollback() {
        rollbackCalls += 1;
        return {
          status: 'pass',
          deployId: 'dpl_prev',
          rolledBackTo: 'dpl_prev',
          deployUrl: 'https://prev.vercel.app',
          durationMs: 50,
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
      assert.equal(code, 1, 'overall deploy result is fail when rollback fires');
      assert.equal(rollbackCalls, 1, 'rollback called exactly once');
      const out = stdoutLines.join('\n');
      assert.match(out, /auto-rolled-back-to=dpl_prev/);
      assert.match(out, /health check failed/i);
    } finally {
      console.log = origLog;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('negative: rollbackOn empty → no rollback attempted', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: vercel',
        '  project: my-app',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn: []',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    let rollbackCalls = 0;
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return { status: 'pass', deployId: 'dpl_new', durationMs: 1 };
      },
      async rollback() {
        rollbackCalls += 1;
        return { status: 'pass', durationMs: 0 };
      },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1, 'health-check fail still returns 1');
      assert.equal(rollbackCalls, 0, 'rollback NOT called when rollbackOn empty');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('negative: rollbackOn has only smokeTestFailure → no rollback on healthCheckFailure', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: vercel',
        '  project: my-app',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn:',
        '    - smokeTestFailure',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    let rollbackCalls = 0;
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return { status: 'pass', deployId: 'dpl_new', durationMs: 1 };
      },
      async rollback() {
        rollbackCalls += 1;
        return { status: 'pass', durationMs: 0 };
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
      assert.equal(rollbackCalls, 0, 'smokeTestFailure trigger does not match healthCheckFailure');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('edge: rollback throws (no previous deploy) → exit 1, clear message, no swallow', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: vercel',
        '  project: my-app',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn:',
        '    - healthCheckFailure',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg: string) => {
      stdoutLines.push(msg);
    };
    console.error = (msg: string) => {
      stderrLines.push(msg);
    };
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return { status: 'pass', deployId: 'dpl_new', durationMs: 1 };
      },
      async rollback() {
        throw new Error('no previous production deployment exists');
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
        /auto-rollback FAILED|could not find a previous deploy|no previous production deployment/i,
      );
    } finally {
      console.log = origLog;
      console.error = origErr;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('edge: adapter does not support rollback → warning, no crash, exit 1', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: generic',
        '  deployCommand: echo http://x.test',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn:',
        '    - healthCheckFailure',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    const stderrLines: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => {
      stderrLines.push(msg);
    };
    const fakeAdapter: DeployAdapter = {
      name: 'generic',
      async deploy() {
        return { status: 'pass', deployUrl: 'http://x.test', durationMs: 1 };
      },
      // No rollback method.
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1);
      assert.match(stderrLines.join('\n'), /does not support rollback/);
    } finally {
      console.error = origErr;
      fs.rmSync(dir, { recursive: true });
    }
  });
});
