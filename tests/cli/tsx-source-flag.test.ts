// tests/cli/tsx-source-flag.test.ts
//
// CLI-level test for the v7.8.0 `--tsx-source` resolution-override flag
// (spec amendment A2). The flag is consumed by `bin/_launcher.js` (picks
// the tsx binary) and re-validated in `src/cli/index.ts` (clear error on
// bad value, strip from argv before subcommand dispatch).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', ENTRY, ...args],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'test-key',
        // Silence the v7.8.0 deprecation warning so it doesn't leak into
        // stderr assertions; this test exercises the flag parser, not the
        // resolver itself.
        CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION: '1',
      },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 1,
  };
}

describe('CLI --tsx-source flag (spec A2)', () => {
  it('FS1: --tsx-source=bundled is accepted and forwarded (no validation error)', () => {
    // Use `--version` as a no-op terminal command so we don't engage any
    // subcommand handlers. Asserts that the flag is recognized and stripped
    // before help/version routing.
    const { code, stderr } = runCli(['--tsx-source=bundled', '--version']);
    assert.equal(code, 0, `expected exit 0, got ${code} (stderr: ${stderr})`);
    assert.equal(
      stderr.includes('Invalid --tsx-source value'),
      false,
      'no validation error for a valid value',
    );
  });

  it('FS2: --tsx-source=foo (invalid) exits 1 with actionable error', () => {
    const { code, stderr } = runCli(['--tsx-source=foo', '--version']);
    assert.equal(code, 1);
    assert.ok(
      stderr.includes("Invalid --tsx-source value 'foo'"),
      `stderr should name the bad value: ${stderr}`,
    );
    assert.ok(
      stderr.includes('Expected bundled, project, path'),
      `stderr should list valid options: ${stderr}`,
    );
  });

  it('FS3: --tsx-source project (separate token) is accepted', () => {
    const { code, stderr } = runCli(['--tsx-source', 'project', '--version']);
    assert.equal(code, 0, `expected exit 0, got ${code} (stderr: ${stderr})`);
  });

  it('FS4: --help mentions --tsx-source under Resolution overrides', () => {
    const { code, stdout } = runCli(['--help']);
    assert.equal(code, 0);
    assert.ok(
      stdout.includes('Resolution overrides'),
      'help should contain the Resolution overrides section',
    );
    assert.ok(stdout.includes('--tsx-source'), 'help should mention --tsx-source');
    assert.ok(
      stdout.includes('CLAUDE_AUTOPILOT_TSX'),
      'help should document the env var equivalent',
    );
  });
});
