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
    const savedFlyToken = process.env.FLY_API_TOKEN;
    const savedRenderKey = process.env.RENDER_API_KEY;
    const savedHome = process.env.HOME;
    delete process.env.VERCEL_TOKEN;
    delete process.env.FLY_API_TOKEN;
    delete process.env.RENDER_API_KEY;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-home-'));
    process.chdir(tmp);
    try {
      await fn();
    } finally {
      process.chdir(savedCwd);
      if (savedToken !== undefined) process.env.VERCEL_TOKEN = savedToken;
      else delete process.env.VERCEL_TOKEN;
      if (savedFlyToken !== undefined) process.env.FLY_API_TOKEN = savedFlyToken;
      else delete process.env.FLY_API_TOKEN;
      if (savedRenderKey !== undefined) process.env.RENDER_API_KEY = savedRenderKey;
      else delete process.env.RENDER_API_KEY;
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

describe('preflight — Fly + Render auth doctor (v5.6 Phase 6)', () => {
  it('warns about missing FLY_API_TOKEN when deploy.adapter is fly', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { captured += args.join(' ') + '\n'; };
    try {
      await withCwd(
        'deploy:\n  adapter: fly\n  appName: my-app\n',
        async () => { await runDoctor(); }
      );
    } finally {
      console.log = origLog;
    }
    assert.match(captured, /FLY_API_TOKEN/);
    assert.match(captured, /fly\.io\/dashboard\/personal\/tokens/);
  });

  it('passes when FLY_API_TOKEN is set and adapter is fly', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { captured += args.join(' ') + '\n'; };
    try {
      await withCwd(
        'deploy:\n  adapter: fly\n',
        async () => {
          // withCwd clears FLY_API_TOKEN at entry; set it inside so the doctor
          // sees it during this run.
          process.env.FLY_API_TOKEN = 'test-fly-token';
          await runDoctor();
        }
      );
    } finally {
      console.log = origLog;
    }
    assert.match(captured, /FLY_API_TOKEN/);
    assert.equal(/fly\.io\/dashboard\/personal\/tokens/.test(captured), false);
  });

  it('warns about missing RENDER_API_KEY when deploy.adapter is render', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { captured += args.join(' ') + '\n'; };
    try {
      await withCwd(
        'deploy:\n  adapter: render\n  serviceId: srv_abc\n',
        async () => { await runDoctor(); }
      );
    } finally {
      console.log = origLog;
    }
    assert.match(captured, /RENDER_API_KEY/);
    assert.match(captured, /dashboard\.render\.com\/u\/settings#api-keys/);
  });

  it('passes when RENDER_API_KEY is set and adapter is render', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { captured += args.join(' ') + '\n'; };
    try {
      await withCwd(
        'deploy:\n  adapter: render\n',
        async () => {
          // withCwd clears RENDER_API_KEY at entry; set it inside so the doctor
          // sees it during this run.
          process.env.RENDER_API_KEY = 'test-render-key';
          await runDoctor();
        }
      );
    } finally {
      console.log = origLog;
    }
    assert.match(captured, /RENDER_API_KEY/);
    assert.equal(/dashboard\.render\.com\/u\/settings#api-keys/.test(captured), false);
  });
});
