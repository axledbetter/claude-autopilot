import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHook, GUARDRAIL_MARKER } from '../src/cli/hook.ts';

function initGitRepo(dir: string): void {
  const r = spawnSync('git', ['init', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
}

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  initGitRepo(dir);
  return dir;
}

describe('hook install — both hooks by default', () => {
  it('writes pre-commit and pre-push when no flags', async () => {
    const dir = makeDir();
    const code = await runHook('install', { cwd: dir });
    assert.equal(code, 0);
    const hooksDir = path.join(dir, '.git', 'hooks');
    assert.ok(fs.existsSync(path.join(hooksDir, 'pre-commit')), 'pre-commit should exist');
    assert.ok(fs.existsSync(path.join(hooksDir, 'pre-push')), 'pre-push should exist');
    assert.ok(fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8').includes(GUARDRAIL_MARKER));
    assert.ok(fs.readFileSync(path.join(hooksDir, 'pre-push'), 'utf8').includes(GUARDRAIL_MARKER));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('hook install --pre-commit-only', () => {
  it('writes only pre-commit hook', async () => {
    const dir = makeDir();
    const code = await runHook('install', { cwd: dir, preCommitOnly: true });
    assert.equal(code, 0);
    const hooksDir = path.join(dir, '.git', 'hooks');
    assert.ok(fs.existsSync(path.join(hooksDir, 'pre-commit')), 'pre-commit should exist');
    assert.ok(!fs.existsSync(path.join(hooksDir, 'pre-push')), 'pre-push should NOT exist');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('hook install --pre-push-only', () => {
  it('writes only pre-push hook', async () => {
    const dir = makeDir();
    const code = await runHook('install', { cwd: dir, prePushOnly: true });
    assert.equal(code, 0);
    const hooksDir = path.join(dir, '.git', 'hooks');
    assert.ok(!fs.existsSync(path.join(hooksDir, 'pre-commit')), 'pre-commit should NOT exist');
    assert.ok(fs.existsSync(path.join(hooksDir, 'pre-push')), 'pre-push should exist');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('hook uninstall', () => {
  it('removes both guardrail-managed hooks', async () => {
    const dir = makeDir();
    await runHook('install', { cwd: dir });
    const code = await runHook('uninstall', { cwd: dir });
    assert.equal(code, 0);
    const hooksDir = path.join(dir, '.git', 'hooks');
    assert.ok(!fs.existsSync(path.join(hooksDir, 'pre-commit')));
    assert.ok(!fs.existsSync(path.join(hooksDir, 'pre-push')));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('hook status', () => {
  it('reports not-installed when no hooks', async () => {
    const dir = makeDir();
    const code = await runHook('status', { cwd: dir, silent: true });
    assert.equal(code, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('reports installed after install', async () => {
    const dir = makeDir();
    await runHook('install', { cwd: dir });
    const code = await runHook('status', { cwd: dir });
    assert.equal(code, 0);
    fs.rmSync(dir, { recursive: true });
  });
});
