import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// readDeployAdapter is internal to preflight.ts. We exercise the doctor
// behavior via runDoctor() rather than re-exporting the helper, but the
// parsing rules are simple enough to test directly by reproducing the
// key regex shape — keep the assertion against runDoctor() the source
// of truth via the larger integration test.
//
// Here we test the heuristic indirectly: run runDoctor() under a cwd that
// has guardrail.config.yaml with `deploy.adapter: vercel` and assert that
// the output mentions VERCEL_TOKEN. Conversely, with `adapter: generic`,
// the VERCEL_TOKEN check should be absent.

import { runDoctor } from '../src/cli/preflight.ts';

function withCwd(yamlContent: string | null, fn: () => Promise<void>): Promise<void> {
  return (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-doctor-'));
    if (yamlContent !== null) {
      fs.writeFileSync(path.join(tmp, 'guardrail.config.yaml'), yamlContent);
    }
    const savedCwd = process.cwd();
    const savedToken = process.env.VERCEL_TOKEN;
    const savedHome = process.env.HOME;
    delete process.env.VERCEL_TOKEN;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-home-'));
    process.chdir(tmp);
    try {
      await fn();
    } finally {
      process.chdir(savedCwd);
      if (savedToken !== undefined) process.env.VERCEL_TOKEN = savedToken;
      else delete process.env.VERCEL_TOKEN;
      if (savedHome !== undefined) process.env.HOME = savedHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
}

describe('preflight — Vercel auth doctor (Phase 6)', () => {
  it('warns about missing VERCEL_TOKEN when deploy.adapter is vercel', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { captured += args.join(' ') + '\n'; };
    try {
      await withCwd(
        'deploy:\n  adapter: vercel\n  projectId: prj_abc\n',
        async () => { await runDoctor(); }
      );
    } finally {
      console.log = origLog;
    }
    assert.match(captured, /VERCEL_TOKEN/);
    assert.match(captured, /vercel\.com\/account\/tokens/);
  });

  it('does not mention VERCEL_TOKEN when deploy.adapter is generic', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { captured += args.join(' ') + '\n'; };
    try {
      await withCwd(
        'deploy:\n  adapter: generic\n  deployCommand: "vercel deploy"\n',
        async () => { await runDoctor(); }
      );
    } finally {
      console.log = origLog;
    }
    assert.equal(/VERCEL_TOKEN/.test(captured), false);
  });

  it('does not mention VERCEL_TOKEN when no deploy block exists', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { captured += args.join(' ') + '\n'; };
    try {
      await withCwd(null, async () => { await runDoctor(); });
    } finally {
      console.log = origLog;
    }
    assert.equal(/VERCEL_TOKEN/.test(captured), false);
  });

  it('passes when VERCEL_TOKEN is set and adapter is vercel', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { captured += args.join(' ') + '\n'; };
    try {
      await withCwd(
        'deploy:\n  adapter: vercel\n',
        async () => {
          // withCwd clears VERCEL_TOKEN at entry; set it inside so the doctor
          // sees it during this run.
          process.env.VERCEL_TOKEN = 'test-token';
          await runDoctor();
        }
      );
    } finally {
      console.log = origLog;
    }
    // Token-set case — we only assert that the line exists with no warning hint
    assert.match(captured, /VERCEL_TOKEN/);
    assert.equal(/vercel\.com\/account\/tokens/.test(captured), false);
  });
});
