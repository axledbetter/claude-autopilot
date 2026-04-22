import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runCommand } from '../../src/cli/run.ts';

describe('runCommand', () => {
  it('R1: returns 1 if guardrail.config.yaml not found', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-run-'));
    try {
      const code = await runCommand({ cwd: dir });
      assert.equal(code, 1);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('R2: dry-run returns 0 when config exists and files provided', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-run-'));
    try {
      await fs.writeFile(path.join(dir, 'guardrail.config.yaml'), 'configVersion: 1\n', 'utf8');
      const code = await runCommand({ cwd: dir, files: ['foo.ts'], dryRun: true });
      assert.equal(code, 0);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('R3: returns 0 when no changed files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-run-'));
    try {
      await fs.writeFile(path.join(dir, 'guardrail.config.yaml'), 'configVersion: 1\n', 'utf8');
      const code = await runCommand({ cwd: dir, files: [] });
      assert.equal(code, 0);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('R4: clean run (no rules/tests/engine) returns 0', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-run-'));
    try {
      await fs.writeFile(path.join(dir, 'guardrail.config.yaml'), 'configVersion: 1\ntestCommand: null\n', 'utf8');
      const code = await runCommand({ cwd: dir, files: ['a.ts'] });
      assert.equal(code, 0);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('R5: failing testCommand returns 1', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-run-'));
    try {
      await fs.writeFile(
        path.join(dir, 'guardrail.config.yaml'),
        'configVersion: 1\ntestCommand: this-cmd-does-not-exist-r5\n',
        'utf8',
      );
      const code = await runCommand({ cwd: dir, files: ['a.ts'] });
      assert.equal(code, 1);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});
