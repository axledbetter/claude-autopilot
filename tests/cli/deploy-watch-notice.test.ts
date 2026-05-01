// tests/cli/deploy-watch-notice.test.ts
//
// Phase 3 of v5.6: the polling-mode adapter notice on `--watch`. When an
// adapter advertises `capabilities.streamMode === 'polling'`, the CLI must
// print exactly one line to stderr BEFORE iteration begins explaining the
// 2s polling cadence. Websocket-mode (and unset / 'none') adapters MUST
// NOT print that notice.
//
// Spec: docs/specs/v5.6-fly-render-adapters.md § "Capability metadata"

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runDeploy } from '../../src/cli/deploy.ts';
import type { DeployAdapter } from '../../src/adapters/deploy/types.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-deploy-watch-notice-'));
}

const POLLING_NOTICE_RE
  = /^\[deploy\] note: \S+ uses 2s log polling — lines may arrive in batches and could include short gaps\. See docs\/deploy\/adapters\.md#log-streaming for details\./m;

describe('runDeploy --watch — polling-mode notice', () => {
  it('prints the one-line stderr notice when adapter.capabilities.streamMode === polling', async () => {
    const dir = makeTmp();
    // We use the `vercel` adapter type in config because the v5.6 config
    // schema validator (Phase 5) still gates `render`/`fly` keys; this test
    // injects a fake adapter via `adapterFactory` that advertises
    // `streamMode: 'polling'`, which is what the notice gating actually
    // keys off of.
    fs.writeFileSync(
      path.join(dir, 'guardrail.config.yaml'),
      'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n',
    );
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;

    const fakeAdapter: DeployAdapter = {
      name: 'render',
      capabilities: { streamMode: 'polling', nativeRollback: false },
      async deploy(input) {
        input.onDeployStart?.('dep_fake');
        // Yield a tick so the streamLogs generator has a chance to start.
        await new Promise((r) => setImmediate(r));
        return { status: 'pass', deployId: 'dep_fake', durationMs: 5 };
      },
      // eslint-disable-next-line require-yield
      async *streamLogs() {
        // No-op iterator — the test only cares about the upfront notice.
      },
    };

    try {
      const code = await runDeploy({
        cwd: dir,
        watch: true,
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 0);
      const allStderr = writes.join('');
      assert.match(
        allStderr,
        POLLING_NOTICE_RE,
        `expected polling notice, got: ${allStderr}`,
      );
      // Sanity — there's only one notice line, not a duplicate per onDeployStart.
      const matches = allStderr.match(/\[deploy\] note: \S+ uses 2s log polling/g) ?? [];
      assert.equal(matches.length, 1, `expected exactly one polling notice, got ${matches.length}`);
    } finally {
      process.stderr.write = origWrite;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('does NOT print the polling notice when adapter.capabilities.streamMode === websocket', async () => {
    const dir = makeTmp();
    fs.writeFileSync(
      path.join(dir, 'guardrail.config.yaml'),
      'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n',
    );
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;

    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      capabilities: { streamMode: 'websocket', nativeRollback: true },
      async deploy(input) {
        input.onDeployStart?.('dpl_fake');
        await new Promise((r) => setImmediate(r));
        return { status: 'pass', deployId: 'dpl_fake', durationMs: 5 };
      },
      // eslint-disable-next-line require-yield
      async *streamLogs() {
        // No-op iterator — websocket-mode adapters get no notice.
      },
    };

    try {
      const code = await runDeploy({
        cwd: dir,
        watch: true,
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 0);
      const allStderr = writes.join('');
      assert.doesNotMatch(
        allStderr,
        /\[deploy\] note: .* uses 2s log polling/,
        `unexpected polling notice for websocket adapter: ${allStderr}`,
      );
    } finally {
      process.stderr.write = origWrite;
      fs.rmSync(dir, { recursive: true });
    }
  });
});
