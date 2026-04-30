import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDeploy } from '../src/cli/deploy.ts';

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
