import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDeploy, runDeployRollback, runDeployStatus } from '../src/cli/deploy.ts';
import type { DeployAdapter } from '../src/adapters/deploy/types.ts';
import type { VercelDeployListItem } from '../src/adapters/deploy/vercel.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-deploy-cli-'));
}

describe('runDeploy CLI', () => {
  // Bugbot HIGH on PR #59 — when --config points at a path that doesn't
  // exist, the prior behavior was to silently fall through to "no adapter
  // configured" instead of saying the config file was missing. The
  // default-path case (no --config flag) intentionally stays silent.
  it('errors clearly when explicit --config path does not exist', async () => {
    const dir = makeTmp();
    const original = console.error;
    let stderr = '';
    console.error = (msg: string) => { stderr += msg + '\n'; };
    try {
      const code = await runDeploy({ cwd: dir, configPath: path.join(dir, 'definitely-not-here.yaml') });
      assert.equal(code, 1);
      assert.match(stderr, /config file not found/);
    } finally {
      console.error = original;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('default-path missing is silent (treated as no config)', async () => {
    const dir = makeTmp();
    const original = console.error;
    let stderr = '';
    console.error = (msg: string) => { stderr += msg + '\n'; };
    try {
      // No --command, no config file at default path → should error on
      // "no adapter configured", NOT "config file not found"
      const code = await runDeploy({ cwd: dir });
      assert.equal(code, 1);
      assert.match(stderr, /no deploy adapter configured/);
      assert.doesNotMatch(stderr, /config file not found/);
    } finally {
      console.error = original;
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('runDeploy --watch', () => {
  it('opts in: streamLogs is invoked and lines reach stderr', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), 'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n');
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;

    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy(input) {
        // Fire onDeployStart synchronously like real Vercel does after POST.
        input.onDeployStart?.('dpl_fake');
        // Give the streamLogs loop a few event-loop ticks to consume.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        return { status: 'pass', deployId: 'dpl_fake', durationMs: 10 };
      },
      async *streamLogs(_input) {
        yield { timestamp: 1, level: 'stdout', text: 'streamed-line-1' };
        yield { timestamp: 2, level: 'stdout', text: 'streamed-line-2' };
      },
    };

    try {
      const code = await runDeploy({
        cwd: dir,
        watch: true,
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 0);
      const allStderr = stderrWrites.join('');
      assert.match(allStderr, /streamed-line-1/);
      assert.match(allStderr, /streamed-line-2/);
    } finally {
      process.stderr.write = origWrite;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('on adapter without streamLogs, prints unsupported warning and continues', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), 'configVersion: 1\ndeploy:\n  adapter: generic\n  deployCommand: echo http://x.test\n');
    const original = console.error;
    let stderr = '';
    console.error = (msg: string) => { stderr += msg + '\n'; };

    const fakeAdapter: DeployAdapter = {
      name: 'generic',
      async deploy() { return { status: 'pass', deployUrl: 'http://x.test', durationMs: 5 }; },
      // No streamLogs method.
    };

    try {
      const code = await runDeploy({
        cwd: dir,
        watch: true,
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 0);
      assert.match(stderr, /--watch ignored/);
      assert.match(stderr, /generic/);
    } finally {
      console.error = original;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('without --watch, streamLogs is not invoked even when supported', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), 'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n');
    let streamCalls = 0;
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy(input) {
        input.onDeployStart?.('dpl_fake');
        return { status: 'pass', deployId: 'dpl_fake', durationMs: 10 };
      },
      // eslint-disable-next-line require-yield
      async *streamLogs() { streamCalls++; },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        watch: false,
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 0);
      assert.equal(streamCalls, 0);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — `deploy rollback` and `deploy status` CLI subverbs.
// ─────────────────────────────────────────────────────────────────────────────

describe('runDeployRollback CLI', () => {
  it('exits 0 and prints rolledBackTo on success', async () => {
    const dir = makeTmp();
    fs.writeFileSync(
      path.join(dir, 'guardrail.config.yaml'),
      'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n',
    );
    const stdoutLines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { stdoutLines.push(msg); };

    let rollbackArg: { to?: string } | undefined;
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() { return { status: 'pass', durationMs: 0 }; },
      async rollback(input) {
        rollbackArg = input;
        return {
          status: 'pass',
          deployId: 'dpl_target',
          rolledBackTo: 'dpl_target',
          deployUrl: 'https://target.vercel.app',
          buildLogsUrl: 'https://vercel.com/me/my-app/dpl_target',
          durationMs: 42,
        };
      },
    };

    try {
      const code = await runDeployRollback({
        cwd: dir,
        to: 'dpl_target',
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 0);
      assert.deepEqual(rollbackArg, { to: 'dpl_target' });
      const all = stdoutLines.join('\n');
      assert.match(all, /rolledBackTo=dpl_target/);
      assert.match(all, /status=pass/);
      assert.match(all, /adapter=vercel/);
    } finally {
      console.log = origLog;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('exits 1 when adapter does not implement rollback', async () => {
    const dir = makeTmp();
    fs.writeFileSync(
      path.join(dir, 'guardrail.config.yaml'),
      'configVersion: 1\ndeploy:\n  adapter: generic\n  deployCommand: echo http://x.test\n',
    );
    const origErr = console.error;
    let stderr = '';
    console.error = (msg: string) => { stderr += msg + '\n'; };

    const fakeAdapter: DeployAdapter = {
      name: 'generic',
      async deploy() { return { status: 'pass', durationMs: 0 }; },
      // No rollback method — generic adapter omits it by design.
    };

    try {
      const code = await runDeployRollback({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 1);
      assert.match(stderr, /does not support rollback/);
      assert.match(stderr, /generic/);
    } finally {
      console.error = origErr;
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('runDeployStatus CLI', () => {
  it('exits 0 and prints current prod plus recent builds', async () => {
    const dir = makeTmp();
    fs.writeFileSync(
      path.join(dir, 'guardrail.config.yaml'),
      'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n',
    );
    const stdoutLines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { stdoutLines.push(msg); };

    const items: VercelDeployListItem[] = [
      { id: 'dpl_a', state: 'READY', createdAt: 5000, url: 'a.vercel.app' },
      { id: 'dpl_b', state: 'READY', createdAt: 4000, url: 'b.vercel.app' },
      { id: 'dpl_c', state: 'READY', createdAt: 3000, url: 'c.vercel.app' },
    ];
    const fakeAdapter: DeployAdapter & { listDeployments(limit?: number): Promise<VercelDeployListItem[]> } = {
      name: 'vercel',
      async deploy() { return { status: 'pass', durationMs: 0 }; },
      async listDeployments() { return items; },
    };

    try {
      const code = await runDeployStatus({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 0);
      const all = stdoutLines.join('\n');
      assert.match(all, /status — adapter=vercel/);
      assert.match(all, /current: dpl_a/);
      assert.match(all, /recent builds:/);
      assert.match(all, /dpl_b/);
      assert.match(all, /dpl_c/);
    } finally {
      console.log = origLog;
      fs.rmSync(dir, { recursive: true });
    }
  });
});
