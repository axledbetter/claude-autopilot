// v7.6.0 — Go scaffolder tests.
//
// Mirrors tests/scaffold-python.test.ts shape: pure-function unit tests for
// the name normalization + body builders, plus end-to-end runScaffold()
// integration tests.
//
// Covers the 8 cases the v7.6.0 spec calls out:
//   1. basic spec writes go.mod + main.go + main_test.go
//   2. module-name normalization: "My App" → "my-app"
//   3. hyphenated names preserved: "my-pkg-2" → "my-pkg-2"
//   4. path-invalid chars in basename → clear error
//   5. never overwrites existing go.mod
//   6. never overwrites existing main.go
//   7. .gitignore augmentation idempotent (run twice → vendor/ once)
//   8. end-to-end: detection picks 'go' from go.mod in spec

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  augmentGitignore,
  buildGoMod,
  buildMainGo,
  buildMainTestGo,
  normalizeGoModuleName,
  scaffoldGo,
} from '../src/cli/scaffold/go.ts';
import { runScaffold } from '../src/cli/scaffold.ts';

function makeTmp(name?: string): string {
  if (name) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-goparent-'));
    const child = path.join(parent, name);
    fs.mkdirSync(child, { recursive: true });
    return child;
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-go-'));
}

function writeSpec(dir: string, body: string): string {
  const p = path.join(dir, 'spec.md');
  fs.writeFileSync(p, body);
  return p;
}

const BASIC_GO_SPEC = `## Files\n\n* \`go.mod\` — module\n* \`main.go\` — entry\n* \`main_test.go\` — table tests\n`;

// ---- Pure-function unit tests.

describe('normalizeGoModuleName', () => {
  it('lowercases + collapses whitespace to "-"', () => {
    assert.equal(normalizeGoModuleName('My App'), 'my-app');
    assert.equal(normalizeGoModuleName('  Spaced   Name  '), '-spaced-name-');
  });

  it('preserves hyphens (Go module paths allow them)', () => {
    assert.equal(normalizeGoModuleName('my-pkg-2'), 'my-pkg-2');
  });

  it('preserves dots (e.g. github.com-style paths)', () => {
    assert.equal(normalizeGoModuleName('foo.bar'), 'foo.bar');
  });

  it('falls back to "app" on empty', () => {
    assert.equal(normalizeGoModuleName(''), 'app');
  });

  it('rejects forward slashes', () => {
    assert.throws(() => normalizeGoModuleName('foo/bar'), /invalid Go module name/);
  });

  it('rejects backslashes + control characters', () => {
    assert.throws(() => normalizeGoModuleName('foo\\bar'), /invalid Go module name/);
    assert.throws(() => normalizeGoModuleName('foo\x00bar'), /invalid Go module name/);
  });
});

describe('buildGoMod / buildMainGo / buildMainTestGo', () => {
  it('go.mod has module + go 1.22 + local-default note', () => {
    const body = buildGoMod('my-app');
    assert.match(body, /^module my-app$/m);
    assert.match(body, /^go 1\.22$/m);
    // Inline note documents the local default (codex NOTE).
    assert.match(body, /local-scaffold default/);
  });

  it('main.go declares package main + has a runnable main()', () => {
    const body = buildMainGo();
    assert.match(body, /^package main$/m);
    assert.match(body, /func main\(\)/);
    assert.match(body, /fmt\.Println/);
  });

  it('main_test.go declares package main + has TestSmoke', () => {
    const body = buildMainTestGo();
    assert.match(body, /^package main$/m);
    assert.match(body, /import "testing"/);
    assert.match(body, /func TestSmoke\(t \*testing\.T\)/);
  });
});

describe('augmentGitignore (idempotent)', () => {
  it('creates content from null with all three entries', () => {
    const result = augmentGitignore(null);
    assert.match(result, /^vendor\/$/m);
    assert.match(result, /^\*\.exe$/m);
    assert.match(result, /^\*\.test$/m);
  });

  it('appends missing entries without duplicating existing', () => {
    const initial = 'node_modules/\nvendor/\n';
    const result = augmentGitignore(initial);
    // vendor/ should appear exactly once.
    const vendorMatches = result.split('\n').filter(l => l.trim() === 'vendor/');
    assert.equal(vendorMatches.length, 1);
    // *.exe + *.test should be added.
    assert.match(result, /^\*\.exe$/m);
    assert.match(result, /^\*\.test$/m);
    // Preserves original content.
    assert.match(result, /^node_modules\/$/m);
  });

  it('returns unchanged when all entries already present (no double-newline drift)', () => {
    const initial = 'vendor/\n*.exe\n*.test\n';
    const result = augmentGitignore(initial);
    assert.equal(result, initial);
  });
});

// ---- Integration tests: runScaffold + scaffoldGo end-to-end.

describe('scaffoldGo (basic end-to-end)', () => {
  it('writes go.mod + main.go + main_test.go for a basic spec', async () => {
    const dir = makeTmp('basicgo');
    const specPath = writeSpec(dir, BASIC_GO_SPEC);
    const result = await runScaffold({ cwd: dir, specPath });
    assert.equal(result.stack, 'go');

    const goMod = fs.readFileSync(path.join(dir, 'go.mod'), 'utf8');
    assert.match(goMod, /^module basicgo$/m);
    assert.match(goMod, /^go 1\.22$/m);

    const mainGo = fs.readFileSync(path.join(dir, 'main.go'), 'utf8');
    assert.match(mainGo, /^package main$/m);
    assert.match(mainGo, /func main\(\)/);

    const testGo = fs.readFileSync(path.join(dir, 'main_test.go'), 'utf8');
    assert.match(testGo, /^package main$/m);
    assert.match(testGo, /func TestSmoke/);

    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('normalizes "My App" cwd → module "my-app"', async () => {
    const dir = makeTmp('My App');
    const specPath = writeSpec(dir, BASIC_GO_SPEC);
    await runScaffold({ cwd: dir, specPath });
    const goMod = fs.readFileSync(path.join(dir, 'go.mod'), 'utf8');
    assert.match(goMod, /^module my-app$/m);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('preserves hyphenated module names ("my-pkg-2" → "my-pkg-2")', async () => {
    const dir = makeTmp('my-pkg-2');
    const specPath = writeSpec(dir, BASIC_GO_SPEC);
    await runScaffold({ cwd: dir, specPath });
    const goMod = fs.readFileSync(path.join(dir, 'go.mod'), 'utf8');
    assert.match(goMod, /^module my-pkg-2$/m);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('rejects path-invalid characters in basename with a clear error', async () => {
    // Simulate cwd basename containing a backslash — call scaffoldGo
    // directly so we can pass a synthesized cwd path. runScaffold
    // path.basename would never see a `/` (Node would treat it as a
    // separator), so we craft a basename with a backslash.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-go-bad-'));
    const badName = 'has\\bad\\char';
    // We can't actually mkdir a directory named with a backslash on most
    // filesystems portably — but the helper is pure: it just consumes
    // path.basename(cwd). We exercise it directly with a synthetic cwd
    // string. The normalization helper is also exported, so we assert
    // both paths:
    assert.throws(() => normalizeGoModuleName(badName), /invalid Go module name/);
    // And via scaffoldGo if we hand it a cwd whose basename is bad.
    const fakeCwd = path.join(parent, badName);
    await assert.rejects(
      scaffoldGo({
        cwd: fakeCwd,
        parsed: { paths: [], packageHints: {} },
        dryRun: true,
      }),
      /invalid Go module name/,
    );
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('never overwrites an existing go.mod', async () => {
    const dir = makeTmp('preservemod');
    fs.writeFileSync(path.join(dir, 'go.mod'), '// preexisting\nmodule keep-me\ngo 1.21\n');
    const specPath = writeSpec(dir, BASIC_GO_SPEC);
    const result = await runScaffold({ cwd: dir, specPath });
    assert.equal(result.stack, 'go');
    const goMod = fs.readFileSync(path.join(dir, 'go.mod'), 'utf8');
    assert.match(goMod, /preexisting/);
    assert.match(goMod, /^module keep-me$/m);
    assert.match(goMod, /^go 1\.21$/m);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('never overwrites an existing main.go', async () => {
    const dir = makeTmp('preservemain');
    const userMain = 'package main\n\n// user code — should not be clobbered\nfunc main() {}\n';
    fs.writeFileSync(path.join(dir, 'main.go'), userMain);
    const specPath = writeSpec(dir, BASIC_GO_SPEC);
    await runScaffold({ cwd: dir, specPath });
    const after = fs.readFileSync(path.join(dir, 'main.go'), 'utf8');
    assert.equal(after, userMain);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('.gitignore augmentation is idempotent (run twice → vendor/ appears once)', async () => {
    const dir = makeTmp('idemignore');
    const specPath = writeSpec(dir, BASIC_GO_SPEC);
    // First run creates .gitignore.
    await runScaffold({ cwd: dir, specPath });
    const first = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    // Second run — should leave it untouched.
    await runScaffold({ cwd: dir, specPath });
    const second = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.equal(first, second);
    const vendorLines = second.split('\n').filter(l => l.trim() === 'vendor/');
    assert.equal(vendorLines.length, 1, `vendor/ should appear once, got ${vendorLines.length}`);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('end-to-end: detection picks "go" from go.mod in spec', async () => {
    const dir = makeTmp('detectgo');
    // Spec lists only go.mod (no main.go in the spec). The Go scaffolder
    // still emits main.go + main_test.go as managed files.
    const specPath = writeSpec(dir, `## Files\n\n* \`go.mod\` — module def\n`);
    const result = await runScaffold({ cwd: dir, specPath });
    assert.equal(result.stack, 'go');
    assert.equal(fs.existsSync(path.join(dir, 'go.mod')), true);
    assert.equal(fs.existsSync(path.join(dir, 'main.go')), true);
    assert.equal(fs.existsSync(path.join(dir, 'main_test.go')), true);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });
});
