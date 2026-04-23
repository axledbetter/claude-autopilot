import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runHook, GUARDRAIL_MARKER } from '../../src/cli/hook.ts';

let tmpDir: string;
let gitDir: string;
let hooksDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  gitDir = path.join(tmpDir, '.git');
  hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('autopilot hook', () => {
  it('install: writes pre-push hook and makes it executable', async () => {
    const code = await runHook('install', { cwd: tmpDir });
    assert.equal(code, 0);
    const hookPath = path.join(hooksDir, 'pre-push');
    assert.ok(fs.existsSync(hookPath), 'hook file should exist');
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(content.includes(GUARDRAIL_MARKER), 'hook should include guardrail marker');
    assert.ok(content.includes('guardrail run'), 'hook should reference guardrail run');
    const mode = fs.statSync(hookPath).mode;
    assert.ok((mode & 0o111) !== 0, 'hook should be executable');
  });

  it('install: exits 1 if non-guardrail hook already exists (no --force)', async () => {
    const hookPath = path.join(hooksDir, 'pre-push');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho existing\n', 'utf8');
    const code = await runHook('install', { cwd: tmpDir });
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(hookPath, 'utf8'), '#!/bin/sh\necho existing\n');
  });

  it('install --force: overwrites existing hook', async () => {
    const hookPath = path.join(hooksDir, 'pre-push');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho existing\n', 'utf8');
    const code = await runHook('install', { cwd: tmpDir, force: true });
    assert.equal(code, 0);
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(content.includes(GUARDRAIL_MARKER));
  });

  it('uninstall: removes guardrail-managed hook files', async () => {
    // Install first so we have guardrail-managed hooks
    await runHook('install', { cwd: tmpDir });
    const preCommitPath = path.join(hooksDir, 'pre-commit');
    const prePushPath = path.join(hooksDir, 'pre-push');
    const code = await runHook('uninstall', { cwd: tmpDir });
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(preCommitPath), 'pre-commit hook should be removed');
    assert.ok(!fs.existsSync(prePushPath), 'pre-push hook should be removed');
  });
});
