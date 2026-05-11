// v7.7.0 — Rust scaffolder.
//
// Mirrors src/cli/scaffold/go.ts (v7.6.0) shape:
//   - single `scaffoldRust()` exported entrypoint
//   - pure-function helpers (name normalization, builders) for unit tests
//   - never overwrites existing files (matches `· exists` log pattern)
//   - tracks filesCreated / dirsCreated / filesSkippedExisting for return
//
// Rust adds a lib-vs-bin fork the Go scaffolder doesn't need:
//
//   - spec lists ONLY `src/lib.rs` (no main.rs)         → library crate
//       Cargo.toml + src/lib.rs (public fn + #[cfg(test)] mod tests)
//       .gitignore augmentation INCLUDES `Cargo.lock` (lockfiles are
//       not committed for libraries — see Cargo docs).
//
//   - spec lists `src/main.rs` (with or without lib.rs) → binary crate
//       Cargo.toml + src/main.rs (println!) + tests/integration_test.rs
//       .gitignore does NOT include Cargo.lock (binaries commit it).
//
//   - spec lists BOTH src/main.rs AND src/lib.rs        → mixed mode
//       Cargo.toml + main.rs + lib.rs + tests/integration_test.rs
//       .gitignore does NOT include Cargo.lock (binary target wins).
//
//   - spec lists NEITHER (or no spec hint)              → default to bin
//       Same as the `src/main.rs`-listed case. Matches `cargo init`
//       default — `cargo init` produces a binary unless `--lib` is
//       passed.
//
// Name normalization: Cargo crate identifiers are `[a-z0-9_]` only, must
// not start with a digit. Lowercase basename(cwd), replace any non-allowed
// char with `_`, collapse runs of `_`, prefix `_` if the result starts
// with a digit.

import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';

import type { ScaffoldResult, ScaffoldRunContext } from './types.ts';

const PASS = '\x1b[32m✓\x1b[0m';
const SKIP = '\x1b[2m·\x1b[0m';
const DIM  = (t: string) => `\x1b[2m${t}\x1b[0m`;

/**
 * Normalize a basename into a valid Cargo crate name.
 *
 * Cargo identifiers: `[a-z0-9_]` only, must not start with a digit.
 *
 * - lowercased
 * - any char outside `[a-z0-9_]` collapses to `_`
 * - repeated `_` runs collapse to a single `_`
 * - if the result starts with a digit, prefix `_`
 * - empty result falls back to `app`
 */
export function normalizeRustCrateName(raw: string): string {
  const lower = raw.toLowerCase();
  // Replace any non-[a-z0-9_] character with `_`.
  const sanitized = lower.replace(/[^a-z0-9_]+/g, '_');
  // Collapse repeated `_` runs.
  const collapsed = sanitized.replace(/_+/g, '_');
  if (collapsed.length === 0) return 'app';
  // Strip leading/trailing underscores that came from leading/trailing
  // separators, BUT preserve a leading `_` we add for digit-start cases.
  const trimmed = collapsed.replace(/^_+|_+$/g, '');
  const base = trimmed.length > 0 ? trimmed : 'app';
  // Cargo crate names cannot start with a digit.
  return /^[0-9]/.test(base) ? `_${base}` : base;
}

/** Build the Cargo.toml body. */
export function buildCargoToml(crateName: string): string {
  return `[package]
name = "${crateName}"
version = "0.1.0"
edition = "2021"

[dependencies]
`;
}

/** Build src/main.rs body — minimal Hello world binary. */
export function buildMainRs(): string {
  return `fn main() {
    println!("Hello from {}", env!("CARGO_PKG_NAME"));
}
`;
}

/** Build src/lib.rs body — public fn + inline tests module. */
export function buildLibRs(): string {
  return `//! Library entrypoint — auto-scaffolded by claude-autopilot.

pub fn hello() -> &'static str {
    "hello"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_works() {
        assert_eq!(hello(), "hello");
    }
}
`;
}

/** Build tests/integration_test.rs body — smoke test. */
export function buildIntegrationTestRs(): string {
  return `#[test]
fn smoke() {
    assert_eq!(2 + 2, 4);
}
`;
}

/**
 * Augment `.gitignore` with Rust-standard ignores. Idempotent.
 *
 * `target/` is always added. `Cargo.lock` is added ONLY when
 * `includeCargoLock` is true (library-only crates — lockfiles aren't
 * committed for libraries per Cargo docs). Binary crates commit
 * Cargo.lock so we leave it out of .gitignore.
 */
export function augmentGitignore(existing: string | null, includeCargoLock: boolean): string {
  const toAddCandidates = includeCargoLock ? ['target/', 'Cargo.lock'] : ['target/'];
  const lines = existing ? existing.split('\n') : [];
  const present = new Set(lines.map(l => l.trim()));
  const toAdd = toAddCandidates.filter(l => !present.has(l));
  if (toAdd.length === 0) return existing ?? '';
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : (existing ?? '');
  return prefix + toAdd.join('\n') + '\n';
}

/**
 * Classify the crate kind based on spec `## Files` paths. See the
 * file header comment for the fork rules.
 */
export type CrateKind = 'binary' | 'library' | 'mixed';

export function classifyCrateKind(paths: string[]): CrateKind {
  const hasMain = paths.includes('src/main.rs');
  const hasLib = paths.includes('src/lib.rs');
  if (hasMain && hasLib) return 'mixed';
  if (hasLib && !hasMain) return 'library';
  // Default: binary (covers `src/main.rs` listed AND the "neither listed"
  // case — matches `cargo init` default behavior).
  return 'binary';
}

export async function scaffoldRust(ctx: ScaffoldRunContext): Promise<ScaffoldResult> {
  const { cwd, parsed, dryRun } = ctx;

  const crateName = normalizeRustCrateName(path.basename(cwd));
  const kind = classifyCrateKind(parsed.paths);
  // Library-only crates omit Cargo.lock from git. Binary + mixed include it.
  const isLibraryOnly = kind === 'library';

  const filesCreated: string[] = [];
  const filesSkippedExisting: string[] = [];
  const dirsCreated: string[] = [];

  // Files we generate with content rather than empty placeholders.
  const MANAGED_FILES = new Set<string>([
    'Cargo.toml',
    'src/main.rs',
    'src/lib.rs',
    'tests/integration_test.rs',
    '.gitignore',
  ]);

  // 1) Create directories implied by spec paths.
  const dirs = new Set<string>();
  for (const p of parsed.paths) {
    const d = path.dirname(p);
    if (d && d !== '.') dirs.add(d);
  }
  // Ensure we'll have a src/ dir for the targets we write.
  if (kind !== 'library') dirs.add('src');
  if (kind === 'library' || kind === 'mixed') dirs.add('src');
  // tests/ dir for binary + mixed integration tests.
  if (kind !== 'library') dirs.add('tests');

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

  // 3) Cargo.toml — never overwrite.
  const cargoAbs = path.join(cwd, 'Cargo.toml');
  if (fs.existsSync(cargoAbs)) {
    filesSkippedExisting.push('Cargo.toml');
    console.log(`  ${SKIP}  exists  ${DIM('Cargo.toml (preserved)')}`);
  } else {
    if (!dryRun) await fsAsync.writeFile(cargoAbs, buildCargoToml(crateName), 'utf8');
    filesCreated.push('Cargo.toml');
    console.log(`  ${PASS}  write   ${DIM(`Cargo.toml (name = "${crateName}", edition 2021)`)}`);
  }

  // 4) src/main.rs — binary + mixed modes only.
  if (kind === 'binary' || kind === 'mixed') {
    const mainAbs = path.join(cwd, 'src', 'main.rs');
    if (fs.existsSync(mainAbs)) {
      filesSkippedExisting.push('src/main.rs');
      console.log(`  ${SKIP}  exists  ${DIM('src/main.rs (preserved)')}`);
    } else {
      if (!dryRun) await fsAsync.writeFile(mainAbs, buildMainRs(), 'utf8');
      filesCreated.push('src/main.rs');
      console.log(`  ${PASS}  write   ${DIM('src/main.rs (println! Hello)')}`);
    }
  }

  // 5) src/lib.rs — library + mixed modes only.
  if (kind === 'library' || kind === 'mixed') {
    const libAbs = path.join(cwd, 'src', 'lib.rs');
    if (fs.existsSync(libAbs)) {
      filesSkippedExisting.push('src/lib.rs');
      console.log(`  ${SKIP}  exists  ${DIM('src/lib.rs (preserved)')}`);
    } else {
      if (!dryRun) await fsAsync.writeFile(libAbs, buildLibRs(), 'utf8');
      filesCreated.push('src/lib.rs');
      console.log(`  ${PASS}  write   ${DIM('src/lib.rs (pub fn + #[cfg(test)] mod tests)')}`);
    }
  }

  // 6) tests/integration_test.rs — binary + mixed modes only.
  if (kind === 'binary' || kind === 'mixed') {
    const testAbs = path.join(cwd, 'tests', 'integration_test.rs');
    if (fs.existsSync(testAbs)) {
      filesSkippedExisting.push('tests/integration_test.rs');
      console.log(`  ${SKIP}  exists  ${DIM('tests/integration_test.rs (preserved)')}`);
    } else {
      if (!dryRun) await fsAsync.writeFile(testAbs, buildIntegrationTestRs(), 'utf8');
      filesCreated.push('tests/integration_test.rs');
      console.log(`  ${PASS}  write   ${DIM('tests/integration_test.rs (smoke test)')}`);
    }
  }

  // 7) .gitignore — idempotent augmentation. Cargo.lock conditional on
  //    library-only crates per Cargo's documented convention.
  const giAbs = path.join(cwd, '.gitignore');
  const existing = fs.existsSync(giAbs) ? await fsAsync.readFile(giAbs, 'utf8') : null;
  const augmented = augmentGitignore(existing, isLibraryOnly);
  const lockNote = isLibraryOnly ? 'target/, Cargo.lock' : 'target/';
  if (existing === null) {
    if (!dryRun) await fsAsync.writeFile(giAbs, augmented, 'utf8');
    filesCreated.push('.gitignore');
    console.log(`  ${PASS}  write   ${DIM(`.gitignore (${lockNote})`)}`);
  } else if (augmented !== existing) {
    if (!dryRun) await fsAsync.writeFile(giAbs, augmented, 'utf8');
    filesCreated.push('.gitignore');
    console.log(`  ${PASS}  augment ${DIM(`.gitignore (added Rust ignores: ${lockNote})`)}`);
  } else {
    filesSkippedExisting.push('.gitignore');
    console.log(`  ${SKIP}  exists  ${DIM('.gitignore (Rust entries already present)')}`);
  }

  return {
    filesCreated,
    dirsCreated,
    filesSkippedExisting,
    // Node-shape fields — Rust scaffolder doesn't touch package.json/tsconfig.
    packageJsonAction: 'skipped-exists',
    tsconfigAction: 'skipped-no-ts',
  };
}
