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

// Tracks per-terminal-session whether the deprecation notice has been shown.
// Uses a temp file keyed by parent PID + stderr's tty so parallel CI jobs don't
// collide. Falls back to always-emit if the stamp can't be written.
const DEPRECATION_STAMP_DIR = path.join(os.tmpdir(), 'claude-autopilot');
function hasShownDeprecation() {
  try {
    if (!fs.existsSync(DEPRECATION_STAMP_DIR)) {
      fs.mkdirSync(DEPRECATION_STAMP_DIR, { recursive: true });
    }
    const key = `${process.ppid}-${process.stderr.isTTY ? 'tty' : 'pipe'}.stamp`;
    const stampPath = path.join(DEPRECATION_STAMP_DIR, key);
    if (fs.existsSync(stampPath)) return true;
    fs.writeFileSync(stampPath, String(Date.now()));
    // Best-effort cleanup of stamps older than 1h to keep tmpdir tidy.
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const f of fs.readdirSync(DEPRECATION_STAMP_DIR)) {
      const p = path.join(DEPRECATION_STAMP_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Decide whether to emit the deprecation notice. Order:
 *   CLAUDE_AUTOPILOT_DEPRECATION=never   → never emit (CI/automation)
 *   CLAUDE_AUTOPILOT_DEPRECATION=always  → always emit (deterministic testing)
 *   otherwise                            → once per terminal session (stamp-based)
 */
function shouldEmitDeprecation() {
  const override = process.env.CLAUDE_AUTOPILOT_DEPRECATION;
  if (override === 'never') return false;
  if (override === 'always') return true;
  return !hasShownDeprecation();
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
