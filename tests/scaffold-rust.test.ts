// v7.7.0 — Rust scaffolder tests.
//
// Mirrors tests/scaffold-go.test.ts shape: pure-function unit tests for the
// crate-name normalizer + body builders, plus end-to-end runScaffold()
// integration tests.
//
// Covers the 10 cases the v7.7.0 plan calls out:
//   1.  Bin crate: spec lists Cargo.toml + src/main.rs → no Cargo.lock in gitignore
//   2.  Lib crate: spec lists Cargo.toml + src/lib.rs (no main.rs) → Cargo.lock IS in gitignore
//   3.  Mixed: spec lists Cargo.toml + main.rs + lib.rs → both targets, no Cargo.lock in gitignore
//   4.  Name normalization: my-pkg-2, 2cool, "My App", foo.bar
//   5.  Existing Cargo.toml preserved
//   6.  Existing src/main.rs preserved
//   7.  .gitignore idempotent (run twice → target/ once)
//   8.  Polyglot: Cargo.toml + package.json → exit 3
//   9.  --stack rust override on spec without Rust signals → binary mode by default
//   10. End-to-end: detection picks 'rust' from Cargo.toml

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  augmentGitignore,
  buildCargoToml,
  buildIntegrationTestRs,
  buildLibRs,
  buildMainRs,
  classifyCrateKind,
  normalizeRustCrateName,
} from '../src/cli/scaffold/rust.ts';
import { runScaffold } from '../src/cli/scaffold.ts';

function makeTmp(name?: string): string {
  if (name) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rustparent-'));
    const child = path.join(parent, name);
    fs.mkdirSync(child, { recursive: true });
    return child;
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rust-'));
}

function writeSpec(dir: string, body: string): string {
  const p = path.join(dir, 'spec.md');
  fs.writeFileSync(p, body);
  return p;
}

const BIN_SPEC = `## Files\n\n* \`Cargo.toml\` — crate\n* \`src/main.rs\` — entry\n`;
const LIB_SPEC = `## Files\n\n* \`Cargo.toml\` — crate\n* \`src/lib.rs\` — lib entry\n`;
const MIXED_SPEC = `## Files\n\n* \`Cargo.toml\` — crate\n* \`src/main.rs\` — entry\n* \`src/lib.rs\` — lib entry\n`;

// ---- Pure-function unit tests.

describe('normalizeRustCrateName', () => {
  it('preserves hyphens by converting to underscores: my-pkg-2 → my_pkg_2', () => {
    assert.equal(normalizeRustCrateName('my-pkg-2'), 'my_pkg_2');
  });

  it('prefixes underscore when result starts with a digit: 2cool → _2cool', () => {
    assert.equal(normalizeRustCrateName('2cool'), '_2cool');
  });

  it('lowercases + replaces whitespace with underscore: "My App" → my_app', () => {
    assert.equal(normalizeRustCrateName('My App'), 'my_app');
  });

  it('replaces dots with underscore: foo.bar → foo_bar', () => {
    assert.equal(normalizeRustCrateName('foo.bar'), 'foo_bar');
  });

  it('falls back to "app" on empty / all-separator input', () => {
    assert.equal(normalizeRustCrateName(''), 'app');
    assert.equal(normalizeRustCrateName('---'), 'app');
  });

  it('collapses repeated separator runs to single underscore', () => {
    assert.equal(normalizeRustCrateName('foo---bar'), 'foo_bar');
    assert.equal(normalizeRustCrateName('foo   bar'), 'foo_bar');
  });
});

describe('buildCargoToml / buildMainRs / buildLibRs / buildIntegrationTestRs', () => {
  it('Cargo.toml has [package] + name + version + edition 2021 + [dependencies]', () => {
    const body = buildCargoToml('my_app');
    assert.match(body, /^\[package\]$/m);
    assert.match(body, /^name = "my_app"$/m);
    assert.match(body, /^version = "0\.1\.0"$/m);
    assert.match(body, /^edition = "2021"$/m);
    assert.match(body, /^\[dependencies\]$/m);
  });

  it('main.rs has fn main() with println! using CARGO_PKG_NAME', () => {
    const body = buildMainRs();
    assert.match(body, /fn main\(\)/);
    assert.match(body, /println!/);
    assert.match(body, /CARGO_PKG_NAME/);
  });

  it('lib.rs has pub fn hello + #[cfg(test)] mod tests + it_works', () => {
    const body = buildLibRs();
    assert.match(body, /pub fn hello\(\)/);
    assert.match(body, /#\[cfg\(test\)\]/);
    assert.match(body, /mod tests/);
    assert.match(body, /fn it_works\(\)/);
  });

  it('integration_test.rs has #[test] fn smoke()', () => {
    const body = buildIntegrationTestRs();
    assert.match(body, /#\[test\]/);
    assert.match(body, /fn smoke\(\)/);
  });
});

describe('classifyCrateKind', () => {
  it('main.rs only → binary', () => {
    assert.equal(classifyCrateKind(['Cargo.toml', 'src/main.rs']), 'binary');
  });
  it('lib.rs only → library', () => {
    assert.equal(classifyCrateKind(['Cargo.toml', 'src/lib.rs']), 'library');
  });
  it('main.rs + lib.rs → mixed', () => {
    assert.equal(classifyCrateKind(['Cargo.toml', 'src/main.rs', 'src/lib.rs']), 'mixed');
  });
  it('neither listed → binary (cargo init default)', () => {
    assert.equal(classifyCrateKind(['Cargo.toml']), 'binary');
  });
});

// ---- Integration tests: runScaffold + scaffoldRust end-to-end.

describe('scaffoldRust — bin / lib / mixed forks', () => {
  it('binary crate: spec lists Cargo.toml + src/main.rs → no Cargo.lock in .gitignore', async () => {
    const dir = makeTmp('basicbin');
    const specPath = writeSpec(dir, BIN_SPEC);
    const result = await runScaffold({ cwd: dir, specPath });
    assert.equal(result.stack, 'rust');

    // Cargo.toml written with normalized basename.
    const cargoToml = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
    assert.match(cargoToml, /^name = "basicbin"$/m);
    assert.match(cargoToml, /^edition = "2021"$/m);

    // src/main.rs generated.
    const mainRs = fs.readFileSync(path.join(dir, 'src', 'main.rs'), 'utf8');
    assert.match(mainRs, /fn main\(\)/);
    assert.match(mainRs, /CARGO_PKG_NAME/);

    // tests/integration_test.rs generated.
    const itRs = fs.readFileSync(path.join(dir, 'tests', 'integration_test.rs'), 'utf8');
    assert.match(itRs, /fn smoke\(\)/);

    // src/lib.rs NOT generated (binary-only).
    assert.equal(fs.existsSync(path.join(dir, 'src', 'lib.rs')), false);

    // .gitignore has target/ but NOT Cargo.lock.
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(gi, /^target\/$/m);
    assert.equal(/^Cargo\.lock$/m.test(gi), false, `Cargo.lock should NOT be in binary-crate .gitignore:\n${gi}`);

    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('library crate: spec lists Cargo.toml + src/lib.rs only → Cargo.lock IS in .gitignore', async () => {
    const dir = makeTmp('basiclib');
    const specPath = writeSpec(dir, LIB_SPEC);
    const result = await runScaffold({ cwd: dir, specPath });
    assert.equal(result.stack, 'rust');

    // src/lib.rs generated, no main.rs / integration test.
    const libRs = fs.readFileSync(path.join(dir, 'src', 'lib.rs'), 'utf8');
    assert.match(libRs, /pub fn hello\(\)/);
    assert.match(libRs, /#\[cfg\(test\)\]/);
    assert.equal(fs.existsSync(path.join(dir, 'src', 'main.rs')), false);
    assert.equal(fs.existsSync(path.join(dir, 'tests', 'integration_test.rs')), false);

    // .gitignore has both target/ AND Cargo.lock (library convention).
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(gi, /^target\/$/m);
    assert.match(gi, /^Cargo\.lock$/m);

    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('mixed crate: spec lists Cargo.toml + main.rs + lib.rs → both targets, no Cargo.lock in .gitignore', async () => {
    const dir = makeTmp('basicmixed');
    const specPath = writeSpec(dir, MIXED_SPEC);
    const result = await runScaffold({ cwd: dir, specPath });
    assert.equal(result.stack, 'rust');

    // Both main.rs + lib.rs + integration test generated.
    assert.match(fs.readFileSync(path.join(dir, 'src', 'main.rs'), 'utf8'), /fn main\(\)/);
    assert.match(fs.readFileSync(path.join(dir, 'src', 'lib.rs'), 'utf8'), /pub fn hello\(\)/);
    assert.match(fs.readFileSync(path.join(dir, 'tests', 'integration_test.rs'), 'utf8'), /fn smoke\(\)/);

    // .gitignore has target/ but NOT Cargo.lock (binary wins).
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(gi, /^target\/$/m);
    assert.equal(/^Cargo\.lock$/m.test(gi), false, `Cargo.lock should NOT be in mixed-crate .gitignore:\n${gi}`);

    fs.rmSync(path.dirname(dir), { recursive: true });
  });
});

describe('scaffoldRust — crate name normalization (end-to-end)', () => {
  it('normalizes "my-pkg-2" → "my_pkg_2", "2cool" → "_2cool", "My App" → "my_app", "foo.bar" → "foo_bar"', async () => {
    const cases: Array<[string, string]> = [
      ['my-pkg-2', 'my_pkg_2'],
      ['2cool', '_2cool'],
      ['My App', 'my_app'],
      ['foo.bar', 'foo_bar'],
    ];
    for (const [basename, expected] of cases) {
      const dir = makeTmp(basename);
      const specPath = writeSpec(dir, BIN_SPEC);
      await runScaffold({ cwd: dir, specPath });
      const cargoToml = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
      assert.match(
        cargoToml,
        new RegExp(`^name = "${expected}"$`, 'm'),
        `basename="${basename}" should produce name="${expected}", got:\n${cargoToml}`,
      );
      fs.rmSync(path.dirname(dir), { recursive: true });
    }
  });
});

describe('scaffoldRust — never overwrites existing files', () => {
  it('preserves an existing Cargo.toml', async () => {
    const dir = makeTmp('preservecargo');
    const preexisting = '[package]\nname = "keep-me"\nversion = "9.9.9"\nedition = "2018"\n\n[dependencies]\nserde = "1"\n';
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), preexisting);
    const specPath = writeSpec(dir, BIN_SPEC);
    await runScaffold({ cwd: dir, specPath });
    const after = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
    assert.equal(after, preexisting);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('preserves an existing src/main.rs', async () => {
    const dir = makeTmp('preservemain');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const userMain = '// user code — should not be clobbered\nfn main() { /* keep me */ }\n';
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'), userMain);
    const specPath = writeSpec(dir, BIN_SPEC);
    await runScaffold({ cwd: dir, specPath });
    const after = fs.readFileSync(path.join(dir, 'src', 'main.rs'), 'utf8');
    assert.equal(after, userMain);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });
});

describe('scaffoldRust — .gitignore idempotency', () => {
  it('.gitignore augmentation is idempotent (run twice → target/ appears once)', async () => {
    const dir = makeTmp('idemignore');
    const specPath = writeSpec(dir, BIN_SPEC);
    await runScaffold({ cwd: dir, specPath });
    const first = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    await runScaffold({ cwd: dir, specPath });
    const second = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.equal(first, second);
    const targetLines = second.split('\n').filter(l => l.trim() === 'target/');
    assert.equal(targetLines.length, 1, `target/ should appear once, got ${targetLines.length}`);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('augmentGitignore — library mode adds Cargo.lock, binary mode does not', () => {
    const libResult = augmentGitignore(null, true);
    assert.match(libResult, /^target\/$/m);
    assert.match(libResult, /^Cargo\.lock$/m);

    const binResult = augmentGitignore(null, false);
    assert.match(binResult, /^target\/$/m);
    assert.equal(/^Cargo\.lock$/m.test(binResult), false);
  });
});

// ---- CLI / polyglot integration via spawnSync.

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'claude-autopilot.js');

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8' });
  return {
    status: r.status ?? -1,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
  };
}

describe('scaffoldRust — polyglot + --stack override + end-to-end detection', () => {
  it('polyglot: Cargo.toml + package.json without --stack → exit 3', () => {
    const dir = makeTmp();
    const specPath = writeSpec(
      dir,
      `## Files\n\n* \`Cargo.toml\` — rust side\n* \`package.json\` — node side\n`,
    );
    const r = runCli(['scaffold', '--from-spec', specPath], dir);
    assert.equal(r.status, 3, `expected exit 3, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /polyglot spec — pass --stack to disambiguate/);
    fs.rmSync(dir, { recursive: true });
  });

  it('--stack rust override on a spec without Rust signals → generates binary mode by default', async () => {
    // Spec lists no Cargo.toml / main.rs / lib.rs — would normally classify
    // as node-fallback. --stack rust forces Rust scaffolding; classifyCrateKind
    // sees no main.rs / lib.rs and defaults to binary (matches `cargo init`).
    const dir = makeTmp('forcedrust');
    const specPath = writeSpec(dir, `## Files\n\n* \`README.md\` — docs only\n`);
    const result = await runScaffold({ cwd: dir, specPath, stack: 'rust' });
    assert.equal(result.stack, 'rust');
    // Binary artifacts generated.
    assert.equal(fs.existsSync(path.join(dir, 'Cargo.toml')), true);
    assert.equal(fs.existsSync(path.join(dir, 'src', 'main.rs')), true);
    assert.equal(fs.existsSync(path.join(dir, 'tests', 'integration_test.rs')), true);
    // Library file NOT generated.
    assert.equal(fs.existsSync(path.join(dir, 'src', 'lib.rs')), false);
    // .gitignore should NOT include Cargo.lock (binary mode default).
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.equal(/^Cargo\.lock$/m.test(gi), false);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('end-to-end via runScaffold(): detection picks "rust" from Cargo.toml', async () => {
    const dir = makeTmp('detectrust');
    // Spec lists only Cargo.toml (no main.rs / lib.rs in the spec).
    // Rust scaffolder defaults to binary mode and still emits main.rs +
    // integration test.
    const specPath = writeSpec(dir, `## Files\n\n* \`Cargo.toml\` — crate def\n`);
    const result = await runScaffold({ cwd: dir, specPath });
    assert.equal(result.stack, 'rust');
    assert.equal(fs.existsSync(path.join(dir, 'Cargo.toml')), true);
    assert.equal(fs.existsSync(path.join(dir, 'src', 'main.rs')), true);
    assert.equal(fs.existsSync(path.join(dir, 'tests', 'integration_test.rs')), true);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });
});
