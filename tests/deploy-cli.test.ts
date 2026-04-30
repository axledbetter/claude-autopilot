import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDeploy } from '../src/cli/deploy.ts';
import type { DeployAdapter } from '../src/adapters/deploy/types.ts';

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
