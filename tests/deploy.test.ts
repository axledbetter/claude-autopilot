import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDeployPhase } from '../src/core/phases/deploy.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-deploy-'));
}

describe('runDeployPhase', () => {
  it('skips when deployCommand is missing', async () => {
    const result = await runDeployPhase({});
    assert.equal(result.status, 'skip');
    assert.equal(result.phase, 'deploy');
  });

  it('passes when command exits 0', async () => {
    const result = await runDeployPhase({ deployCommand: 'echo deployed' });
    assert.equal(result.status, 'pass');
    assert.match(result.output ?? '', /deployed/);
  });

  it('fails when command exits non-zero', async () => {
    const result = await runDeployPhase({ deployCommand: 'exit 1' });
    assert.equal(result.status, 'fail');
    assert.match(result.output ?? '', /Deploy command failed/);
  });

  it('extracts the first https URL from output as deployUrl', async () => {
    const result = await runDeployPhase({
      deployCommand: 'echo "Deploying... done. URL: https://my-app-abc123.vercel.app"',
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.deployUrl, 'https://my-app-abc123.vercel.app');
  });

  it('strips trailing punctuation from extracted URL', async () => {
    const result = await runDeployPhase({
      deployCommand: 'echo "Deployed at https://example.com/app."',
    });
    assert.equal(result.deployUrl, 'https://example.com/app');
  });

  it('returns no deployUrl when none is in output', async () => {
    const result = await runDeployPhase({ deployCommand: 'echo "no url here"' });
    assert.equal(result.status, 'pass');
    assert.equal(result.deployUrl, undefined);
  });

  it('runs in the cwd directory when given', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'hi');
    const result = await runDeployPhase({ deployCommand: 'ls marker.txt', cwd: dir });
    assert.equal(result.status, 'pass');
    assert.match(result.output ?? '', /marker\.txt/);
    fs.rmSync(dir, { recursive: true });
  });

  // Bugbot HIGH on PR #56 — only stdout was captured on failure, so deploy
  // failures hid the actual diagnostic (most CLIs write errors to stderr).
  it('captures stderr in failure output, not just stdout', async () => {
    const result = await runDeployPhase({
      deployCommand: 'echo "stdout-line"; echo "stderr-line" 1>&2; exit 7',
    });
    assert.equal(result.status, 'fail');
    assert.match(result.output ?? '', /stdout-line/);
    assert.match(result.output ?? '', /stderr-line/);
  });
});
