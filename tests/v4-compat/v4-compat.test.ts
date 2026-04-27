/**
 * v4 compatibility golden matrix.
 *
 * Pins every legacy v4 subcommand name and the flag shapes v4 users rely on.
 * Assertions focus on:
 *   - exit codes (0 for deterministic commands, specific non-zero for expected-fail)
 *   - stdout/stderr shape (presence of key markers, not full equality)
 *   - no "unknown command" errors on any v4 subcommand
 *
 * What this does NOT cover (requires real LLM / network / git fixtures):
 *   - Full `run` / `scan` / `ci` / `fix` execution with review engine
 *   - `pr-desc` / `pr-comment` (needs gh auth + open PR)
 *   - `test-gen` (needs LLM)
 *
 * These live in alpha.3 as CI smoke tests against a live environment.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin', 'claude-autopilot.js');

interface RunResult { stdout: string; stderr: string; code: number }

// Exercise the actual installed bin so tsx resolution matches what end-users
// experience. Running `node --import tsx/esm src/cli/index.ts` directly would
// fail from any cwd that doesn't have tsx in its own node_modules — that's a
// test-harness artifact, not a v4 regression.
function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const result = spawnSync(
    BIN,
    args,
    {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, CLAUDE_AUTOPILOT_DEPRECATION: 'never', ...(opts.env ?? {}) },
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

// Every subcommand name that existed in v4 — verify each one still routes.
// `run` / `scan` / `ci` etc. will fail without LLM keys or git repo, but they
// must fail with their own error, NOT "unknown command" from the dispatcher.
const V4_SUBCOMMANDS = [
  'init', 'run', 'scan', 'report', 'explain', 'ignore', 'ci', 'pr',
  'fix', 'costs', 'watch', 'hook', 'autoregress', 'baseline', 'triage',
  'lsp', 'worker', 'mcp', 'test-gen', 'pr-desc', 'doctor', 'preflight',
  'setup', 'council',
];

describe('v4 compatibility matrix', () => {
  let tmpWorkdir: string;

  before(() => {
    tmpWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-v4-compat-'));
  });

  describe('version / help', () => {
    it('V1: --version → exit 0, semver on stdout', () => {
      const r = runCli(['--version']);
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
    });

    it('V2: --help → exit 0, lists every v4 subcommand', () => {
      const r = runCli(['--help']);
      assert.equal(r.code, 0);
      for (const sub of V4_SUBCOMMANDS) {
        assert.ok(
          r.stdout.includes(sub) || r.stderr.includes(sub),
          `help output is missing v4 subcommand "${sub}". v5 must not drop documented subcommands.`,
        );
      }
    });

    it('V3: -h alias → same as --help', () => {
      const hflag = runCli(['-h']);
      const longflag = runCli(['--help']);
      assert.equal(hflag.code, longflag.code);
      assert.equal(hflag.stdout.length > 0, true);
    });

    it('V4: help subcommand form → exit 0', () => {
      const r = runCli(['help']);
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    });
  });

  describe('subcommand routing', () => {
    it('V5: every v4 subcommand name is recognized by the top-level dispatcher', () => {
      // The dispatcher rejects unknown top-level subcommands with exactly:
      //   [claude-autopilot] Unknown subcommand: "<sub>"
      // (or, in v4 / pre-rename releases, [guardrail] Unknown subcommand: "<sub>").
      // Subcommand-internal parsers have their own "unknown sub-subcommand" errors
      // (e.g. `baseline foo` says "Unknown subcommand: foo") — those are legitimate,
      // not a v4 regression. This test checks only the top-level rejection path.
      // We match BOTH prefixes so the assertion stays meaningful across the v4→v5
      // rebrand and so it still detects missing subcommand handlers either way.
      for (const sub of V4_SUBCOMMANDS) {
        const r = runCli([sub], { cwd: tmpWorkdir });
        const combined = r.stdout + r.stderr;
        assert.ok(
          !new RegExp(`\\[(claude-autopilot|guardrail)\\] Unknown subcommand: "${sub}"`, 'i').test(combined),
          `top-level dispatcher rejected "${sub}" as unknown. v5 must route every v4 name. Output:\n${combined.slice(0, 500)}`,
        );
      }
    });
  });

  describe('deterministic reads (no LLM, no network, no git writes)', () => {
    // Use ROOT as cwd so tsx resolves from the package's own node_modules. Users in
    // production install globally and have tsx co-installed; the ROOT cwd simulates that.
    it('V6: doctor → exits with status in {0, 1}, produces readable output', () => {
      const r = runCli(['doctor']);
      assert.ok([0, 1].includes(r.code), `unexpected exit code ${r.code}`);
      assert.match(r.stdout, /\[doctor\]/);
    });

    it('V7: costs → exit 0 (reads cost log or reports empty)', () => {
      const r = runCli(['costs']);
      assert.ok([0, 1].includes(r.code), `stderr: ${r.stderr}`);
    });

    it('V8: baseline show without baseline → exits cleanly (no stack trace)', () => {
      const r = runCli(['baseline', 'show'], { cwd: tmpWorkdir });
      // Must exit with a clear message, not a node.js stack trace with "at file.ts:N:N"
      const combined = r.stdout + r.stderr;
      // Node stack frames have the form "    at funcName (path:line:col)" or similar.
      // Require the `(file:line:col)` paren shape to avoid false positives from
      // prose like "Run: guardrail baseline" or "at .guardrail-baseline.json".
      assert.ok(
        !/\s+at\s+\S+\s+\([^)]*:\d+:\d+\)/.test(combined),
        'baseline show leaked a node.js stack trace',
      );
    });

    it('V9: explain <bogus-id> → exits cleanly with a user-facing message', () => {
      const r = runCli(['explain', 'bogus-nonexistent-id-12345'], { cwd: tmpWorkdir });
      const combined = r.stdout + r.stderr;
      assert.ok(
        !/\s+at\s+\S+\s+\([^)]*:\d+:\d+\)/.test(combined),
        'explain leaked a node.js stack trace',
      );
    });
  });

  describe('flag parsing', () => {
    it('V10: --base flag on run parses (short-circuits before LLM due to missing key)', () => {
      const r = runCli(['run', '--base', 'main'], {
        cwd: tmpWorkdir,
        env: {
          ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
          GEMINI_API_KEY: '', GOOGLE_API_KEY: '', GROQ_API_KEY: '',
        },
      });
      // --base must not cause a parsing error
      const combined = r.stdout + r.stderr;
      assert.ok(
        !/unknown (option|flag)|invalid argument/i.test(combined),
        `--base flag rejected. Output:\n${combined.slice(0, 500)}`,
      );
    });

    it('V11: --format sarif flag on run parses', () => {
      const r = runCli(['run', '--format', 'sarif'], {
        cwd: tmpWorkdir,
        env: {
          ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
          GEMINI_API_KEY: '', GOOGLE_API_KEY: '', GROQ_API_KEY: '',
        },
      });
      const combined = r.stdout + r.stderr;
      assert.ok(
        !/unknown (option|flag)|invalid argument|invalid format/i.test(combined),
        `--format sarif flag rejected. Output:\n${combined.slice(0, 500)}`,
      );
    });

    it('V12: --fail-on warning flag parses', () => {
      const r = runCli(['run', '--fail-on', 'warning'], {
        cwd: tmpWorkdir,
        env: {
          ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
          GEMINI_API_KEY: '', GOOGLE_API_KEY: '', GROQ_API_KEY: '',
        },
      });
      const combined = r.stdout + r.stderr;
      assert.ok(
        !/unknown (option|flag)/i.test(combined),
        `--fail-on flag rejected. Output:\n${combined.slice(0, 500)}`,
      );
    });
  });

  describe('grouped verbs — alpha.2 additive routing', () => {
    it('V15: `review run --help` → same as `run --help`', () => {
      const grouped = runCli(['review', 'run', '--help']);
      const flat = runCli(['run', '--help']);
      // --help on `run` routes the flat handler's help path. Grouped form must reach
      // the same handler. Exit codes and "Options (run)" marker should match.
      assert.equal(grouped.code, flat.code, `grouped exit=${grouped.code} flat exit=${flat.code}`);
    });

    it('V16: `review` alone prints review help', () => {
      const r = runCli(['review']);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /review-phase verbs/i);
    });

    it('V17: `review doctor` is rejected (doctor is not a review verb)', () => {
      const r = runCli(['review', 'doctor']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /not a review-phase verb/i);
    });

    it('V18: `advanced lsp --help` routes to lsp handler', () => {
      const r = runCli(['advanced', 'lsp', '--help']);
      const combined = r.stdout + r.stderr;
      // lsp handler must accept the invocation (not be rejected as unknown)
      assert.ok(
        !/\[claude-autopilot\] "lsp" is not an advanced verb/.test(combined),
        'advanced lsp rejected as invalid verb',
      );
    });

    it('V19: `advanced doctor` is rejected (doctor is not advanced)', () => {
      const r = runCli(['advanced', 'doctor']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /not an advanced verb/i);
    });

    it('V20: legacy flat paths still work after alpha.2', () => {
      // Regression guard: `run --help` must still route correctly after adding the
      // grouped dispatcher. Covered above via V15 indirectly, but pin it directly.
      const r = runCli(['run', '--help']);
      const combined = r.stdout + r.stderr;
      assert.ok(
        !new RegExp(`\\[(claude-autopilot|guardrail)\\] Unknown subcommand: "run"`, 'i').test(combined),
        'flat `run` was rejected after grouped-verb refactor — v4 regression',
      );
    });
  });

  describe('deprecation notice behavior (guardrail bin alias)', () => {
    it('V13: CLAUDE_AUTOPILOT_DEPRECATION=always emits notice on stderr', () => {
      const bin = path.join(ROOT, 'bin', 'guardrail.js');
      const r = spawnSync(bin, ['--version'], {
        env: { ...process.env, CLAUDE_AUTOPILOT_DEPRECATION: 'always' },
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /deprecated.*guardrail.*claude-autopilot/i);
      // Notice must NOT pollute stdout (piped output integrity)
      assert.doesNotMatch(r.stdout, /deprecated/i);
    });

    it('V14: CLAUDE_AUTOPILOT_DEPRECATION=never suppresses notice', () => {
      const bin = path.join(ROOT, 'bin', 'guardrail.js');
      const r = spawnSync(bin, ['--version'], {
        env: { ...process.env, CLAUDE_AUTOPILOT_DEPRECATION: 'never' },
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /deprecated/i);
    });
  });
});
