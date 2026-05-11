// src/cli/tsx-resolver.ts
//
// Cross-platform tsx resolver used by the CLI launcher when the dev/source
// path is taken (running .ts files via `node --import tsx`). Returns a
// `{command, args, source}` triple so spawning is portable (Windows uses
// `.cmd` shims; spawn via process.execPath + the resolved JS entry to avoid
// shebang / PATHEXT quirks).
//
// Precedence (default):
//   1. project-local — <projectRoot>/node_modules/tsx (via createRequire)
//   2. PATH — hand-rolled cross-platform lookup (no `which` dep)
//   3. bundled — this package's own bundled tsx (with a once-per-day
//      deprecation warning; tsx is scheduled to be removed from runtime
//      deps in v8.0.0).
//
// Escape hatches (in priority order, both skip precedence):
//   --tsx-source=<bundled|project|path>     (CLI flag, "forcedBy: flag")
//   CLAUDE_AUTOPILOT_TSX=<bundled|project|path>  (env, "forcedBy: env")
//
// Deprecation warning is silenced by CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION=1.
// Filesystem dedup writes (state dir) are non-fatal — even if the state
// dir can't be created, the warning still prints (intentional: readonly
// homedir in CI should not change semantics).
//
// Amendments from codex pass 2 wired in:
//   A1 — `createRequire(import.meta.url)` at module scope (ESM-safe)
//   A3 — PATH-resolved bin that lives inside our own node_modules is
//        treated as `bundled` so the warning still fires
//   A6 — hand-rolled PATH lookup (drops the `which` dep)
//   A7 — XDG_STATE_HOME / CLAUDE_AUTOPILOT_STATE_DIR for warning dedup

import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A1: createRequire at module scope so `require.resolve('tsx/package.json')`
// works in ESM-compiled output (the package is `"type": "module"`).
const require = createRequire(import.meta.url);

export type TsxSource = 'project-local' | 'path' | 'bundled';

export interface TsxResolution {
  /** Command to spawn (absolute path, normally `process.execPath`). */
  command: string;
  /** Args prepended before the user script path. */
  args: string[];
  /** Where tsx came from — drives the deprecation warning. */
  source: TsxSource;
  /** Override origin if env var or CLI flag forced this resolution. */
  forcedBy?: 'env' | 'flag';
}

export interface ResolveOpts {
  projectRoot: string;
  /** Value of CLAUDE_AUTOPILOT_TSX env var, if set. */
  envOverride?: string;
  /** Value of --tsx-source CLI flag, if passed. */
  flagOverride?: 'bundled' | 'project' | 'path';
  /** Test helper — suppress deprecation warning even on bundled fallthrough. */
  suppressWarning?: boolean;
  /** Test helper — inject process.env (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Test helper — inject process.platform (defaults to process.platform). */
  platform?: NodeJS.Platform;
}

const VALID_SOURCES: ReadonlyArray<'bundled' | 'project' | 'path'> = [
  'bundled',
  'project',
  'path',
];

export function resolveTsx(opts: ResolveOpts): TsxResolution {
  const { projectRoot, envOverride, flagOverride } = opts;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  // --- Escape hatch: --tsx-source flag (highest priority) ---
  if (flagOverride) {
    return resolveFromSource(flagOverride, projectRoot, 'flag', { env, platform });
  }

  // --- Escape hatch: CLAUDE_AUTOPILOT_TSX env var ---
  if (envOverride && (VALID_SOURCES as readonly string[]).includes(envOverride)) {
    return resolveFromSource(envOverride as 'bundled' | 'project' | 'path', projectRoot, 'env', { env, platform });
  }

  // --- Normal precedence ladder ---
  const projectResolved = tryProjectLocal(projectRoot);
  if (projectResolved) return projectResolved;

  const pathResolved = tryPath({ env, platform });
  if (pathResolved) return pathResolved;

  // Fall back to bundled tsx + (maybe) deprecation warning.
  const bundled = resolveBundled();
  if (!opts.suppressWarning) {
    emitTsxDeprecationWarningSafe({ env, platform });
  }
  return bundled;
}

function tryProjectLocal(projectRoot: string): TsxResolution | null {
  try {
    const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
    const pkgPath = projectRequire.resolve('tsx/package.json');
    return buildResolutionFromPkgJson(pkgPath, 'project-local');
  } catch {
    return null;
  }
}

interface PathLookupOpts {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

/**
 * Hand-rolled PATH lookup (A6 — drops the `which` dep). On Windows, walk
 * PATHEXT for each entry; on POSIX, look for the bare `tsx` filename.
 */
function tryPath(opts: PathLookupOpts): TsxResolution | null {
  const PATH = opts.env.PATH ?? opts.env.Path ?? '';
  if (!PATH) return null;

  const isWin = opts.platform === 'win32';
  const PATHEXT = isWin
    ? (opts.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const sep = isWin ? ';' : ':';

  // A3 prep: figure out our bundled directory so we can detect a
  // PATH entry that actually points back at our own node_modules.
  let bundledDir: string | null = null;
  try {
    const bundled = resolveBundled();
    bundledDir = path.dirname(bundled.args[0] ?? '');
  } catch {
    // If we can't even resolve the bundled tsx (shouldn't happen — it's a
    // dep), continue without the self-pointer guard. The worst case is we
    // miss the warning on a corner-case install.
    bundledDir = null;
  }

  for (const rawDir of PATH.split(sep)) {
    const dir = rawDir.trim();
    if (!dir) continue;
    for (const ext of PATHEXT) {
      const candidate = path.join(dir, `tsx${ext}`);
      if (!existsSync(candidate)) continue;

      // A3 — PATH hit that is actually inside our bundled node_modules
      // is not really "user-supplied tsx on PATH"; fall through to bundled
      // so the deprecation warning still fires.
      if (bundledDir && path.resolve(candidate).startsWith(path.resolve(bundledDir))) {
        return null;
      }

      // For a PATH-resolved bin, spawn it directly. On Windows the .cmd
      // shim handles dispatching to node; on Unix the shebang does.
      return { command: candidate, args: [], source: 'path' };
    }
  }
  return null;
}

function resolveBundled(): TsxResolution {
  const pkgPath = require.resolve('tsx/package.json');
  return buildResolutionFromPkgJson(pkgPath, 'bundled');
}

/**
 * Read tsx's package.json `bin` (string or object) and produce a
 * resolution that spawns the bin via `node <bin-js>`. This avoids
 * shebang/PATHEXT quirks across platforms.
 */
function buildResolutionFromPkgJson(pkgPath: string, source: TsxSource): TsxResolution {
  const pkgDir = path.dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };

  let binRel: string | undefined;
  if (typeof pkg.bin === 'string') {
    binRel = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    binRel = pkg.bin.tsx;
  }
  if (!binRel) {
    throw new Error(`tsx package.json at ${pkgPath} has no bin.tsx entry`);
  }

  const binAbs = path.resolve(pkgDir, binRel);
  if (!existsSync(binAbs)) {
    throw new Error(`tsx bin ${binAbs} declared in package.json but missing on disk`);
  }

  // Spawn the bin .js via node directly. Portable across Windows/Unix —
  // no .cmd shim required, no PATHEXT lookups, no shebang dependency.
  return { command: process.execPath, args: [binAbs], source };
}

function resolveFromSource(
  source: 'bundled' | 'project' | 'path',
  projectRoot: string,
  forcedBy: 'env' | 'flag',
  pathOpts: PathLookupOpts,
): TsxResolution {
  let result: TsxResolution | null = null;
  if (source === 'project') result = tryProjectLocal(projectRoot);
  else if (source === 'path') result = tryPath(pathOpts);
  else result = resolveBundled();

  if (!result) {
    throw new Error(
      `tsx source=${source} requested via ${forcedBy} but resolution failed. ` +
        `Install tsx in your project or unset the override.`,
    );
  }
  return { ...result, forcedBy };
}

// ---------------------------------------------------------------------------
// Deprecation warning + state dir (A7)
// ---------------------------------------------------------------------------

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

/**
 * Compute the state dir for warning dedup (A7).
 *   1. CLAUDE_AUTOPILOT_STATE_DIR explicit override
 *   2. POSIX + XDG_STATE_HOME set → $XDG_STATE_HOME/claude-autopilot
 *   3. fallback → ~/.claude-autopilot
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.CLAUDE_AUTOPILOT_STATE_DIR) return env.CLAUDE_AUTOPILOT_STATE_DIR;
  if (platform !== 'win32' && env.XDG_STATE_HOME) {
    return path.join(env.XDG_STATE_HOME, 'claude-autopilot');
  }
  return path.join(os.homedir(), '.claude-autopilot');
}

function emitTsxDeprecationWarningSafe(opts: PathLookupOpts): void {
  // Opt-out for CI / log-hygiene.
  if (opts.env.CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION === '1') return;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const dedupPath = path.join(stateDir(opts.env, opts.platform), '.tsx-deprecation-shown');

  try {
    if (existsSync(dedupPath)) {
      const lastShown = readFileSync(dedupPath, 'utf8').trim();
      if (lastShown === today) return;
    }
  } catch {
    // unreadable — fall through and print (better than silently swallowing)
  }

  try {
    mkdirSync(path.dirname(dedupPath), { recursive: true });
    writeFileSync(dedupPath, today);
  } catch {
    // Non-fatal: readonly homedir / sandbox / etc. We still print the
    // warning below — the user might see it twice in a row, but that's
    // preferable to silently swallowing in CI.
  }

  process.stderr.write(TSX_DEPRECATION_MESSAGE);
}

// Exported for testing.
export const __TSX_DEPRECATION_MESSAGE = TSX_DEPRECATION_MESSAGE;
