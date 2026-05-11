// v7.6.0 — Go scaffolder.
//
// Mirrors the Python scaffolder shape:
//   - single `scaffoldGo()` exported entrypoint
//   - pure-function helpers (name normalization, builders) for unit tests
//   - never overwrites existing files (matches `· exists` log pattern)
//   - tracks filesCreated / dirsCreated / filesSkippedExisting for return
//
// Output for a basic spec (`## Files` listing go.mod + main.go + main_test.go):
//   - go.mod with `module <basename(cwd)>` and `go 1.22`. Inline comment
//     documents the local-scaffold-default per codex NOTE (not a real
//     hosted module path — users override before publishing).
//   - main.go: package main + Hello world (only when not under cmd/<name>/)
//   - main_test.go: smoke test
//   - .gitignore augmentation: appends `vendor/`, `*.exe`, `*.test`
//     idempotently — if already present, leaves them alone.
//
// Name normalization: lowercased basename(cwd), whitespace -> `-`. Dots and
// hyphens preserved (Go module paths permit them). Path-invalid chars
// (`/`, `\`, control chars) are rejected with a clear error.

import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';

import type { ScaffoldResult, ScaffoldRunContext } from './types.ts';

const PASS = '\x1b[32m✓\x1b[0m';
const SKIP = '\x1b[2m·\x1b[0m';
const DIM  = (t: string) => `\x1b[2m${t}\x1b[0m`;

/**
 * Normalize a basename into a valid Go module name.
 *
 * - lowercased
 * - whitespace runs collapse to a single `-`
 * - dots + hyphens preserved (Go modules allow them)
 * - empty result falls back to `app`
 *
 * Throws on path-invalid characters (`/`, `\`, NUL, other control chars) —
 * the caller is expected to surface this as a scaffold error.
 */
export function normalizeGoModuleName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\/\\\x00-\x1f]/.test(raw)) {
    throw new Error(
      `invalid Go module name "${raw}" — path/control characters not allowed`,
    );
  }
  const lower = raw.toLowerCase();
  const collapsed = lower.replace(/\s+/g, '-');
  return collapsed.length > 0 ? collapsed : 'app';
}

/** Build the go.mod body. Inline comment documents the local-default. */
export function buildGoMod(moduleName: string): string {
  return `// NOTE: module name is the local-scaffold default (basename of cwd).
// Replace with your full module path (e.g. github.com/<user>/${moduleName})
// before publishing or running \`go install\`.
module ${moduleName}

go 1.22
`;
}

/** Build main.go body — minimal Hello world package. */
export function buildMainGo(): string {
  return [
    'package main',
    '',
    'import "fmt"',
    '',
    'func main() {',
    '\tfmt.Println("Hello, world!")',
    '}',
    '',
  ].join('\n');
}

/** Build main_test.go body — table-test friendly smoke test. */
export function buildMainTestGo(): string {
  return [
    'package main',
    '',
    'import "testing"',
    '',
    'func TestSmoke(t *testing.T) {',
    '\t// Smoke test scaffolded by claude-autopilot. Replace with real',
    '\t// table-driven cases for your package under test.',
    '}',
    '',
  ].join('\n');
}

/** Lines to append to .gitignore. Idempotent — only adds missing entries. */
const GO_GITIGNORE_LINES = ['vendor/', '*.exe', '*.test'] as const;

/**
 * Augment `.gitignore` with Go-standard ignores. Idempotent: if `vendor/`
 * already appears the second invocation leaves it alone. Creates the file
 * if it doesn't exist.
 */
export function augmentGitignore(existing: string | null): string {
  const lines = existing ? existing.split('\n') : [];
  const present = new Set(lines.map(l => l.trim()));
  const toAdd = GO_GITIGNORE_LINES.filter(l => !present.has(l));
  if (toAdd.length === 0) return existing ?? '';
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : (existing ?? '');
  return prefix + toAdd.join('\n') + '\n';
}

/**
 * True when the spec lists ONLY a `cmd/<name>/main.go` style entrypoint
 * (no top-level main.go). In that case we skip generating the top-level
 * main.go — the spec author intends the cmd/ layout.
 */
function specHasCmdMainOnly(paths: string[]): boolean {
  const hasTopMain = paths.includes('main.go');
  const hasCmdMain = paths.some(p => /^cmd\/[^/]+\/main\.go$/.test(p));
  return hasCmdMain && !hasTopMain;
}

export async function scaffoldGo(ctx: ScaffoldRunContext): Promise<ScaffoldResult> {
  const { cwd, parsed, dryRun } = ctx;

  const moduleName = normalizeGoModuleName(path.basename(cwd));

  const filesCreated: string[] = [];
  const filesSkippedExisting: string[] = [];
  const dirsCreated: string[] = [];

  // Files we generate with content rather than empty placeholders.
  const MANAGED_FILES = new Set<string>(['go.mod', 'main.go', 'main_test.go', '.gitignore']);

  // 1) Create directories implied by spec paths.
  const dirs = new Set<string>();
  for (const p of parsed.paths) {
    const d = path.dirname(p);
    if (d && d !== '.') dirs.add(d);
  }
  for (const d of dirs) {
    const abs = path.join(cwd, d);
    if (fs.existsSync(abs)) continue;
    if (!dryRun) await fsAsync.mkdir(abs, { recursive: true });
    dirsCreated.push(d);
    console.log(`  ${PASS}  mkdir   ${DIM(d + '/')}`);
  }

  // 2) Empty-placeholder pass for spec paths we don't manage.
  for (const p of parsed.paths) {
    if (MANAGED_FILES.has(p)) continue;
    const abs = path.join(cwd, p);
    if (fs.existsSync(abs)) {
      filesSkippedExisting.push(p);
      console.log(`  ${SKIP}  exists  ${DIM(p)}`);
      continue;
    }
    if (!dryRun) {
      await fsAsync.mkdir(path.dirname(abs), { recursive: true });
      await fsAsync.writeFile(abs, '', 'utf8');
    }
    filesCreated.push(p);
    console.log(`  ${PASS}  touch   ${DIM(p)}`);
  }

  // 3) go.mod — never overwrite.
  const goModAbs = path.join(cwd, 'go.mod');
  if (fs.existsSync(goModAbs)) {
    filesSkippedExisting.push('go.mod');
    console.log(`  ${SKIP}  exists  ${DIM('go.mod (preserved)')}`);
  } else {
    if (!dryRun) await fsAsync.writeFile(goModAbs, buildGoMod(moduleName), 'utf8');
    filesCreated.push('go.mod');
    console.log(`  ${PASS}  write   ${DIM(`go.mod (module ${moduleName}, go 1.22)`)}`);
  }

  // 4) main.go — only if the spec doesn't push us to a cmd/<name>/ layout.
  const cmdOnly = specHasCmdMainOnly(parsed.paths);
  if (!cmdOnly) {
    const mainAbs = path.join(cwd, 'main.go');
    if (fs.existsSync(mainAbs)) {
      filesSkippedExisting.push('main.go');
      console.log(`  ${SKIP}  exists  ${DIM('main.go (preserved)')}`);
    } else {
      if (!dryRun) await fsAsync.writeFile(mainAbs, buildMainGo(), 'utf8');
      filesCreated.push('main.go');
      console.log(`  ${PASS}  write   ${DIM('main.go (package main + Hello)')}`);
    }
  }

  // 5) main_test.go — only when we also wrote main.go (same cmd-only guard).
  if (!cmdOnly) {
    const testAbs = path.join(cwd, 'main_test.go');
    if (fs.existsSync(testAbs)) {
      filesSkippedExisting.push('main_test.go');
      console.log(`  ${SKIP}  exists  ${DIM('main_test.go (preserved)')}`);
    } else {
      if (!dryRun) await fsAsync.writeFile(testAbs, buildMainTestGo(), 'utf8');
      filesCreated.push('main_test.go');
      console.log(`  ${PASS}  write   ${DIM('main_test.go (TestSmoke stub)')}`);
    }
  }

  // 6) .gitignore — idempotent augmentation.
  const giAbs = path.join(cwd, '.gitignore');
  const existing = fs.existsSync(giAbs) ? await fsAsync.readFile(giAbs, 'utf8') : null;
  const augmented = augmentGitignore(existing);
  if (existing === null) {
    if (!dryRun) await fsAsync.writeFile(giAbs, augmented, 'utf8');
    filesCreated.push('.gitignore');
    console.log(`  ${PASS}  write   ${DIM('.gitignore (vendor/, *.exe, *.test)')}`);
  } else if (augmented !== existing) {
    if (!dryRun) await fsAsync.writeFile(giAbs, augmented, 'utf8');
    // Treat as "augmented" — not in skipped-existing (we modified it) and
    // not in filesCreated (we didn't create a new file). For now we count
    // it as filesCreated since the user sees a write. Tests assert
    // idempotence on disk content, not on this return shape.
    filesCreated.push('.gitignore');
    console.log(`  ${PASS}  augment ${DIM('.gitignore (added Go ignores)')}`);
  } else {
    filesSkippedExisting.push('.gitignore');
    console.log(`  ${SKIP}  exists  ${DIM('.gitignore (Go entries already present)')}`);
  }

  return {
    filesCreated,
    dirsCreated,
    filesSkippedExisting,
    // Node-shape fields — Go scaffolder doesn't touch package.json/tsconfig.
    packageJsonAction: 'skipped-exists',
    tsconfigAction: 'skipped-no-ts',
  };
}
