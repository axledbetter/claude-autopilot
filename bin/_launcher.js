// Shared launcher for both `claude-autopilot` and `guardrail` bins.
// Imported, not a bin itself. Resolves tsx, spawns src/cli/index.ts with
// the caller's argv, forwards stdio, exits with the child's status.

import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPILED = path.resolve(__dirname, '..', 'dist', 'src', 'cli', 'index.js');
const SOURCE = path.resolve(__dirname, '..', 'src', 'cli', 'index.ts');

/**
 * Pick the best available entrypoint. Compiled (dist/) is preferred for global
 * installs — no tsx dependency, faster startup. Source+tsx is used in dev from the
 * repo itself. Result determines the spawn strategy below.
 */
function resolveEntry() {
  if (fs.existsSync(COMPILED)) return { kind: 'compiled', path: COMPILED };
  if (fs.existsSync(SOURCE)) return { kind: 'source', path: SOURCE };
  return null;
}

function findTsx() {
  const own = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(own)) return own;
  const consumer = path.resolve(__dirname, '..', '..', '..', '.bin', 'tsx');
  if (fs.existsSync(consumer)) return consumer;
  return 'tsx';
}

// v7.1.7 — Per-calendar-day deprecation dedup, keyed in the user's home dir.
//
// The previous (v6.3+) implementation used a temp file keyed by `process.ppid
// + stderr.isTTY` to dedup once per "terminal session." That worked in
// interactive shells but FAILED for the most common deprecation trigger —
// the pre-commit/pre-push git hooks. Git spawns a fresh shell for each hook
// invocation, so the parent PID is fresh on every commit, the stamp file
// path is unique each time, and the notice printed on every single commit.
// The v7.1.6 blank-repo benchmark agent surfaced this as the #1 paper cut.
//
// New strategy: stamp at `~/.claude-autopilot/.deprecation-shown`, contents =
// `YYYY-MM-DD` (UTC). Show at most once per day per machine. Operator gets a
// daily reminder of the rename without per-commit spam. Override env vars
// (`CLAUDE_AUTOPILOT_DEPRECATION=always|never`) preserved.
const DEPRECATION_STAMP_PATH = path.join(os.homedir(), '.claude-autopilot', '.deprecation-shown');
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
function hasShownDeprecationToday() {
  try {
    if (!fs.existsSync(DEPRECATION_STAMP_PATH)) return false;
    return fs.readFileSync(DEPRECATION_STAMP_PATH, 'utf8').trim() === todayUtc();
  } catch {
    // Stamp unreadable — show notice (better than silently swallowing).
    return false;
  }
}
function markDeprecationShown() {
  try {
    const dir = path.dirname(DEPRECATION_STAMP_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DEPRECATION_STAMP_PATH, todayUtc());
  } catch { /* best-effort; missing stamp re-prints next invocation */ }
}

/**
 * Decide whether to emit the deprecation notice. Order:
 *   CLAUDE_AUTOPILOT_DEPRECATION=never   → never emit (CI/automation)
 *   CLAUDE_AUTOPILOT_DEPRECATION=always  → always emit (deterministic testing)
 *   otherwise                            → at most once per UTC day
 */
function shouldEmitDeprecation() {
  const override = process.env.CLAUDE_AUTOPILOT_DEPRECATION;
  if (override === 'never') return false;
  if (override === 'always') return true;
  return !hasShownDeprecationToday();
}

/**
 * Launch the CLI with `argv` passed through verbatim.
 * @param {{ name: 'claude-autopilot' | 'guardrail' }} opts
 */
export function launch(opts) {
  if (opts.name === 'guardrail' && shouldEmitDeprecation()) {
    process.stderr.write(
      '\x1b[33m[deprecated]\x1b[0m `guardrail` CLI is renamed to `claude-autopilot`. ' +
      'The `guardrail` alias works through v5.x and will be removed in v6. ' +
      'Migration guide: https://github.com/axledbetter/claude-autopilot/blob/master/docs/migration/v4-to-v5.md\n' +
      'Silence: set CLAUDE_AUTOPILOT_DEPRECATION=never\n',
    );
    // v7.1.7 — mark stamp AFTER successful emission so a write-failure on
    // stderr still results in the next invocation re-trying. Skip when
    // CLAUDE_AUTOPILOT_DEPRECATION=always (deterministic-testing override
    // shouldn't write the stamp).
    if (process.env.CLAUDE_AUTOPILOT_DEPRECATION !== 'always') {
      markDeprecationShown();
    }
  }

  const entry = resolveEntry();
  if (!entry) {
    process.stderr.write(
      '[claude-autopilot] Could not find CLI entrypoint. Expected either\n' +
      `  ${COMPILED} (compiled) or\n` +
      `  ${SOURCE} (source)\n` +
      'Reinstall: npm install -g @delegance/claude-autopilot@alpha\n',
    );
    process.exit(127);
  }

  let result;
  if (entry.kind === 'compiled') {
    // Fast path — plain node, no tsx dep. Used by global installs (ships dist/).
    result = spawnSync(process.execPath, [entry.path, ...process.argv.slice(2)], { stdio: 'inherit' });
  } else {
    // Dev path — run source via tsx. Used from the repo itself, or by users who
    // installed from git or linked a local copy.
    result = spawnSync(findTsx(), [entry.path, ...process.argv.slice(2)], { stdio: 'inherit' });
  }

  if (result.error) {
    // ENOENT or similar spawn failure — surface cleanly instead of hanging.
    process.stderr.write(`[claude-autopilot] Failed to launch CLI: ${result.error.message}\n`);
    process.exit(127);
  }
  if (result.signal) {
    // Forward child signal by re-raising equivalently
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}
