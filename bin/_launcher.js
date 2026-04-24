// Shared launcher for both `claude-autopilot` and `guardrail` bins.
// Imported, not a bin itself. Resolves tsx, spawns src/cli/index.ts with
// the caller's argv, forwards stdio, exits with the child's status.

import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = path.resolve(__dirname, '..', 'src', 'cli', 'index.ts');

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
 * Launch the CLI with `argv` passed through verbatim.
 * @param {{ name: 'claude-autopilot' | 'guardrail' }} opts
 */
export function launch(opts) {
  if (opts.name === 'guardrail' && !hasShownDeprecation()) {
    process.stderr.write(
      '\x1b[33m[deprecated]\x1b[0m `guardrail` CLI is renamed to `claude-autopilot`. ' +
      'The `guardrail` alias works through v5.x and will be removed in v6. ' +
      'Migration guide: https://github.com/axledbetter/claude-autopilot/blob/master/docs/migration/v4-to-v5.md\n',
    );
  }
  const result = spawnSync(findTsx(), [ENTRYPOINT, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
