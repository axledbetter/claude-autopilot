import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runCommand } from '../../src/cli/run.ts';

// Capture process.exit calls without actually exiting
function patchExit(): { codes: number[]; restore: () => void } {
  const codes: number[] = [];
  const orig = process.exit.bind(process);
  process.exit = ((code?: number) => { codes.push(code ?? 0); throw new Error(`exit:${code ?? 0}`); }) as typeof process.exit;
  return { codes, restore: () => { process.exit = orig; } };
}

describe('runCommand', () => {
  it('R1: exits with error if autopilot.config.yaml not found', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-run-'));
    const patch = patchExit();
    try {
      await runCommand({ cwd: dir }).catch(() => {});
    } finally {
      patch.restore();
      await fs.rm(dir, { recursive: true });
    }
    assert.equal(patch.codes[0], 1);
  });

  it('R2: dry-run exits 0 when config exists and files provided', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-run-'));
    const patch = patchExit();
    try {
      // Write a minimal config
      await fs.writeFile(path.join(dir, 'autopilot.config.yaml'), 'configVersion: 1\n', 'utf8');
      await runCommand({ cwd: dir, files: ['foo.ts'], dryRun: true }).catch(() => {});
    } finally {
      patch.restore();
      await fs.rm(dir, { recursive: true });
    }
    assert.equal(patch.codes[0], 0);
  });

  it('R3: exits 0 when no changed files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-run-'));
    const patch = patchExit();
    try {
      await fs.writeFile(path.join(dir, 'autopilot.config.yaml'), 'configVersion: 1\n', 'utf8');
      await runCommand({ cwd: dir, files: [] }).catch(() => {});
    } finally {
      patch.restore();
      await fs.rm(dir, { recursive: true });
    }
    assert.equal(patch.codes[0], 0);
  });

  it('R4: runs pipeline and exits 0 on clean run (no rules, no tests, no engine)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-run-'));
    const patch = patchExit();
    try {
      await fs.writeFile(path.join(dir, 'autopilot.config.yaml'), 'configVersion: 1\ntestCommand: null\n', 'utf8');
      await runCommand({ cwd: dir, files: ['a.ts'] }).catch(() => {});
    } finally {
      patch.restore();
      await fs.rm(dir, { recursive: true });
    }
    assert.equal(patch.codes[0], 0);
  });

  it('R5: runs pipeline and exits 1 on test failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-run-'));
    const patch = patchExit();
    try {
      await fs.writeFile(
        path.join(dir, 'autopilot.config.yaml'),
        'configVersion: 1\ntestCommand: this-cmd-does-not-exist-r5\n',
        'utf8',
      );
      await runCommand({ cwd: dir, files: ['a.ts'] }).catch(() => {});
    } finally {
      patch.restore();
      await fs.rm(dir, { recursive: true });
    }
    assert.equal(patch.codes[0], 1);
  });
});
