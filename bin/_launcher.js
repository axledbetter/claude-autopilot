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

// v7.8.0 — three-tier tsx resolution (project-local → PATH → bundled) with
// a once-per-day deprecation warning on the bundled fallthrough. This is a
// JS port of src/cli/tsx-resolver.ts (which remains the testable source of
// truth used by autoregress, --tsx-source flag handling, and other call
// sites). The launcher can't import the TS resolver directly because it
// runs BEFORE tsx is available, so the two implementations are kept in
// sync by hand. See docs/specs/v7.8.0-decouple-runtime-deps.md.
//
// Escape hatches:
//   --tsx-source=<bundled|project|path>     (parsed from argv, then stripped)
//   CLAUDE_AUTOPILOT_TSX=<bundled|project|path>
//   CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION=1   (silences bundled-fallthrough warning)
const TSX_VALID_SOURCES = ['bundled', 'project', 'path'];

function readTsxFlagOverride(argv) {
  // Find --tsx-source=foo or --tsx-source foo without disturbing other argv
  // (we surface "invalid value" diagnostics from the CLI's own arg parser
  // when it sees the still-present flag — only strip and use it here).
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--tsx-source=')) {
      const v = a.slice('--tsx-source='.length);
      return TSX_VALID_SOURCES.includes(v) ? v : null;
    }
    if (a === '--tsx-source' && i + 1 < argv.length) {
      const v = argv[i + 1];
      return TSX_VALID_SOURCES.includes(v) ? v : null;
    }
  }
  return null;
}

function bundledTsxPath() {
  // Our own bundled tsx — relative to the package root (two levels up from bin/).
  const p = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
  return fs.existsSync(p) ? p : null;
}
function projectLocalTsxPath() {
  // Consumer project — when installed as a dep, npm hoists peer bins to
  // <consumer>/node_modules/.bin/tsx.
  const p = path.resolve(__dirname, '..', '..', '..', '.bin', 'tsx');
  return fs.existsSync(p) ? p : null;
}
function pathTsxPath() {
  const PATH = process.env.PATH || process.env.Path || '';
  if (!PATH) return null;
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const bundled = bundledTsxPath();
  const bundledDir = bundled ? path.dirname(bundled) : null;
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, `tsx${ext}`);
      if (fs.existsSync(cand)) {
        // A3 self-pointer: if PATH-resolved bin lives inside our bundled
        // node_modules, treat it as bundled so the deprecation warning
        // still fires.
        if (bundledDir && path.resolve(cand).startsWith(path.resolve(bundledDir))) {
          return null;
        }
        return cand;
      }
    }
  }
  return null;
}

function stateDir() {
  if (process.env.CLAUDE_AUTOPILOT_STATE_DIR) return process.env.CLAUDE_AUTOPILOT_STATE_DIR;
  if (process.platform !== 'win32' && process.env.XDG_STATE_HOME) {
    return path.join(process.env.XDG_STATE_HOME, 'claude-autopilot');
  }
  return path.join(os.homedir(), '.claude-autopilot');
}

const TSX_DEPRECATION_MESSAGE =
  '\n' +
  '[deprecation] @delegance/claude-autopilot is using its bundled `tsx` to run\n' +
  '              your TypeScript scripts. In v8.0.0, `tsx` will be removed from\n' +
  '              runtime deps and you will need to install it yourself:\n' +
  '\n' +
  '                  npm install -D tsx\n' +
  '\n' +
  '              To silence this warning now and prepare for v8.0.0:\n' +
  '                1. Add `tsx` to your project devDependencies, OR\n' +
  '                2. Set `CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION=1` in your env.\n' +
  '\n' +
  '              Override resolution: `CLAUDE_AUTOPILOT_TSX=bundled|project|path`\n' +
  '              See docs/specs/v7.8.0-decouple-runtime-deps.md for details.\n';

function emitTsxDeprecationWarningSafe() {
  if (process.env.CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION === '1') return;
  const today = new Date().toISOString().slice(0, 10);
  const dedupPath = path.join(stateDir(), '.tsx-deprecation-shown');
  try {
    if (fs.existsSync(dedupPath)) {
      const lastShown = fs.readFileSync(dedupPath, 'utf8').trim();
      if (lastShown === today) return;
    }
  } catch { /* unreadable — fall through and print */ }
  try {
    fs.mkdirSync(path.dirname(dedupPath), { recursive: true });
    fs.writeFileSync(dedupPath, today);
  } catch { /* non-fatal */ }
  process.stderr.write(TSX_DEPRECATION_MESSAGE);
}

/**
 * Resolve a tsx executable using the v7.8.0 precedence ladder. Returns an
 * absolute path. Honors --tsx-source / CLAUDE_AUTOPILOT_TSX overrides, with
 * --tsx-source taking priority. On bundled fallthrough (no override), emits
 * the once-per-day deprecation warning unless silenced.
 */
function findTsx() {
  const flagOverride = readTsxFlagOverride(process.argv.slice(2));
  const envOverride = process.env.CLAUDE_AUTOPILOT_TSX;
  const override = flagOverride
    || (TSX_VALID_SOURCES.includes(envOverride) ? envOverride : null);

  if (override === 'project') {
    return projectLocalTsxPath() || 'tsx';
  }
  if (override === 'path') {
    return pathTsxPath() || 'tsx';
  }
  if (override === 'bundled') {
    return bundledTsxPath() || 'tsx';
  }

  // Default precedence: project → PATH → bundled (with deprecation warning).
  const project = projectLocalTsxPath();
  if (project) return project;
  const fromPath = pathTsxPath();
  if (fromPath) return fromPath;
  emitTsxDeprecationWarningSafe();
  return bundledTsxPath() || 'tsx';
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
