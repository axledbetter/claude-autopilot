// tests/cli/no-engine-flag-removed.test.ts
//
// v7.0 Phase 6 — spec test #1 — covers the engine-flag removal at the
// dispatcher boundary.
//
// (a) `--no-engine` → invalid_config exit 1.
// (b) help text contains zero `--no-engine` mentions.
// (c) `CLAUDE_AUTOPILOT_ENGINE=off` → emits `engine_off_removed` warning
//     + still runs engine-on (via the run.warning event in the lifecycle).
//
// We exercise (a) and (c) by spawning the bundled CLI binary in a child
// process so we observe real stderr + exit codes (the dispatcher exits
// the process; module-level imports can't be re-driven mid-test). (b) is
// pinned via the in-process `buildHelpText()` helper.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildHelpText } from '../../src/cli/help-text.ts';
import {
  ENGINE_FLAG_DEPRECATION_MESSAGE,
  ENGINE_OFF_REMOVED_MESSAGE,
  ENGINE_OFF_ENV_REMOVED_MESSAGE,
} from '../../src/cli/engine-flag-deprecation.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI_BIN = path.join(REPO_ROOT, 'bin', 'claude-autopilot.js');

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'no-engine-flag-removed-'));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ----------------------------------------------------------------------------
// Test #1(a) — `--no-engine` rejected
// ----------------------------------------------------------------------------

describe('v7.0 — `--no-engine` removed', () => {
  it('exits 1 with invalid_config and a removal hint on `--no-engine`', () => {
    const cwd = tmpProject();
    try {
      // Use a verb that supports flag parsing (costs is cheap and pure).
      const result = spawnSync(
        process.execPath,
        [CLI_BIN, 'costs', '--no-engine'],
        { cwd, encoding: 'utf8' },
      );
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stderr=${result.stderr}`);
      assert.ok(
        /invalid_config/.test(result.stderr) ||
        /--no-engine was removed/i.test(result.stderr),
        `stderr should mention invalid_config / removal — got: ${result.stderr}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it('exposes the exact ENGINE_OFF_REMOVED_MESSAGE constant for downstream parsers', () => {
    assert.match(ENGINE_OFF_REMOVED_MESSAGE, /--no-engine/);
    assert.match(ENGINE_OFF_REMOVED_MESSAGE, /v7\.0/);
    assert.match(ENGINE_OFF_REMOVED_MESSAGE, /removed/);
  });
});

// ----------------------------------------------------------------------------
// Test #1(b) — help text mentions zero `--no-engine`
// ----------------------------------------------------------------------------

describe('v7.0 — help text contains no `--no-engine` mentions', () => {
  it('buildHelpText() output has zero --no-engine occurrences', () => {
    const help = buildHelpText();
    const occurrences = (help.match(/--no-engine/g) ?? []).length;
    assert.equal(occurrences, 0, `expected zero --no-engine occurrences in help; got ${occurrences}`);
  });

  it('buildHelpText() still mentions --engine (deprecated no-op shim)', () => {
    const help = buildHelpText();
    assert.match(help, /--engine/, 'help should still document --engine as a deprecated no-op');
  });
});

// ----------------------------------------------------------------------------
// Test #1(c) — `CLAUDE_AUTOPILOT_ENGINE=off` emits warning, still runs
// ----------------------------------------------------------------------------

describe('v7.0 — `CLAUDE_AUTOPILOT_ENGINE=off` is a soft deprecation', () => {
  it('exposes ENGINE_OFF_ENV_REMOVED_MESSAGE for downstream parsers', () => {
    // Codex pass-3 NOTE #2 — pin the exact stderr text in the test.
    assert.match(ENGINE_OFF_ENV_REMOVED_MESSAGE, /CLAUDE_AUTOPILOT_ENGINE=off/);
    assert.match(ENGINE_OFF_ENV_REMOVED_MESSAGE, /v7\.0/);
    assert.match(ENGINE_OFF_ENV_REMOVED_MESSAGE, /no effect/);
  });

  it('CLI invocation with CLAUDE_AUTOPILOT_ENGINE=off prints the warning to stderr', () => {
    const cwd = tmpProject();
    try {
      const result = spawnSync(
        process.execPath,
        [CLI_BIN, 'costs'],
        {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, CLAUDE_AUTOPILOT_ENGINE: 'off' },
        },
      );
      // Don't assert exit code — costs may fail for unrelated reasons in
      // a tmpdir. Just assert the deprecation banner reached stderr.
      assert.ok(
        /CLAUDE_AUTOPILOT_ENGINE=off has no effect in v7\.0\+/.test(result.stderr),
        `stderr should include the env-off deprecation banner — got: ${result.stderr}`,
      );
    } finally {
      cleanup(cwd);
    }
  });
});

// ----------------------------------------------------------------------------
// Bonus: --engine still works as a no-op shim with a one-shot warning.
// Codex pass-3 NOTE #2 anchor.
// ----------------------------------------------------------------------------

describe('v7.0 — `--engine` is a no-op shim with one-shot per-process warning', () => {
  it('exposes ENGINE_FLAG_DEPRECATION_MESSAGE for downstream parsers', () => {
    assert.match(ENGINE_FLAG_DEPRECATION_MESSAGE, /--engine/);
    assert.match(ENGINE_FLAG_DEPRECATION_MESSAGE, /no-op/);
    assert.match(ENGINE_FLAG_DEPRECATION_MESSAGE, /v7\.0/);
  });

  it('CLI invocation with --engine prints the deprecation banner to stderr', () => {
    const cwd = tmpProject();
    try {
      const result = spawnSync(
        process.execPath,
        [CLI_BIN, 'costs', '--engine'],
        { cwd, encoding: 'utf8' },
      );
      assert.ok(
        /--engine is a no-op in v7\.0\+/.test(result.stderr),
        `stderr should include --engine deprecation banner — got: ${result.stderr}`,
      );
    } finally {
      cleanup(cwd);
    }
  });
});
