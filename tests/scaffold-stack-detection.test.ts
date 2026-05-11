// v7.4.0 — stack detection from `## Files` paths.
//
// These tests pin the precedence ladder documented at the top of
// src/cli/scaffold.ts. The C1 / W2 / W3 / W5 / N2 codes refer to the
// codex pass on docs/specs/v7.4.0-scaffold-python.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectStack,
  parseSpecFiles,
  printStackList,
  SUPPORTED_STACKS,
} from '../src/cli/scaffold.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-stack-'));
}

function writeSpec(dir: string, body: string): string {
  const p = path.join(dir, 'spec.md');
  fs.writeFileSync(p, body);
  return p;
}

const NODE_SPEC = `## Files\n\n* \`package.json\` — node esm\n* \`src/foo.js\` — pure\n`;
const PYTHON_SPEC = `## Files\n\n* \`pyproject.toml\` — PEP 621\n* \`src/myapp/__init__.py\` — pkg root\n`;
const FASTAPI_SPEC = `## Files\n\n* \`pyproject.toml\` — fastapi project\n* \`src/myapp/main.py\` — fastapi entry\n`;
const POLYGLOT_SPEC = `## Files\n\n* \`package.json\` — node side\n* \`pyproject.toml\` — python side\n`;
const GO_SPEC = `## Files\n\n* \`go.mod\` — module def\n* \`main.go\` — entry\n`;
const RUST_SPEC = `## Files\n\n* \`Cargo.toml\` — crate def\n* \`src/main.rs\` — entry\n`;
const RUBY_SPEC = `## Files\n\n* \`Gemfile\` — bundler\n* \`lib/foo.rb\` — code\n`;
const AMBIGUOUS_SPEC = `## Files\n\n* \`README.md\` — only doc\n* \`docs/intro.md\` — overview\n`;

describe('detectStack — precedence ladder', () => {
  it('classifies a Python spec (pyproject.toml) as python', () => {
    const parsed = parseSpecFiles(PYTHON_SPEC)!;
    const result = detectStack(parsed);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.stack, 'python');
  });

  it('classifies a FastAPI spec as fastapi (codex C1 — checked BEFORE Python)', () => {
    const parsed = parseSpecFiles(FASTAPI_SPEC)!;
    // Sanity: parser saw the fastapi mention.
    assert.equal(parsed.packageHints.stackHint, 'fastapi');
    const result = detectStack(parsed);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.stack, 'fastapi');
  });

  it('classifies a Node spec (package.json) as node', () => {
    const parsed = parseSpecFiles(NODE_SPEC)!;
    const result = detectStack(parsed);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.stack, 'node');
  });

  it('classifies a Go spec (go.mod) as go (v7.6 — was unsupported in v7.4/v7.5)', () => {
    const parsed = parseSpecFiles(GO_SPEC)!;
    const result = detectStack(parsed);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.stack, 'go');
  });

  it('returns "polyglot" when both package.json + pyproject.toml are listed without --stack (codex W3)', () => {
    const parsed = parseSpecFiles(POLYGLOT_SPEC)!;
    const result = detectStack(parsed);
    assert.equal(result.kind, 'polyglot');
    if (result.kind === 'polyglot') {
      assert.match(result.message, /polyglot spec — pass --stack to disambiguate/);
    }
  });

  it('v7.6 — lone go.mod detects as go (polyglot-aware: single supported signal)', () => {
    const parsed = parseSpecFiles(`## Files\n\n* \`go.mod\` — module def\n`)!;
    const result = detectStack(parsed);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.stack, 'go');
  });

  it('v7.6 — go.mod + package.json without --stack → polyglot exit 3', () => {
    const md = `## Files\n\n* \`go.mod\` — go side\n* \`package.json\` — node side\n`;
    const parsed = parseSpecFiles(md)!;
    const result = detectStack(parsed);
    assert.equal(result.kind, 'polyglot');
    if (result.kind === 'polyglot') {
      assert.match(result.message, /polyglot spec — pass --stack to disambiguate/);
    }
  });

  it('falls through to node for an ambiguous spec with no root marker', () => {
    const parsed = parseSpecFiles(AMBIGUOUS_SPEC)!;
    const result = detectStack(parsed);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.stack, 'node');
  });

  it('classifies a Rust spec (Cargo.toml) as rust (v7.7 — was unsupported in v7.4-v7.6)', () => {
    const rustParsed = parseSpecFiles(RUST_SPEC)!;
    const rustResult = detectStack(rustParsed);
    assert.equal(rustResult.kind, 'resolved');
    if (rustResult.kind === 'resolved') assert.equal(rustResult.stack, 'rust');
  });

  it('still flags Ruby (Gemfile) as detected-but-unsupported (Rust + Go promoted in v7.6/v7.7)', () => {
    const rubyParsed = parseSpecFiles(RUBY_SPEC)!;
    const rubyResult = detectStack(rubyParsed);
    assert.equal(rubyResult.kind, 'unsupported');
    if (rubyResult.kind === 'unsupported') assert.equal(rubyResult.stack, 'ruby');
  });

  it('v7.7 — lone Cargo.toml detects as rust (polyglot-aware: single supported signal)', () => {
    const parsed = parseSpecFiles(`## Files\n\n* \`Cargo.toml\` — crate def\n`)!;
    const result = detectStack(parsed);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.stack, 'rust');
  });

  it('v7.7 — Cargo.toml + package.json without --stack → polyglot exit 3', () => {
    const md = `## Files\n\n* \`Cargo.toml\` — rust side\n* \`package.json\` — node side\n`;
    const parsed = parseSpecFiles(md)!;
    const result = detectStack(parsed);
    assert.equal(result.kind, 'polyglot');
    if (result.kind === 'polyglot') {
      assert.match(result.message, /polyglot spec — pass --stack to disambiguate/);
    }
  });
});

describe('--stack override', () => {
  it('forces python even when path heuristics would pick node', () => {
    const parsed = parseSpecFiles(NODE_SPEC)!;
    const result = detectStack(parsed, 'python');
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.stack, 'python');
  });

  it('SUPPORTED_STACKS lists node + python + fastapi + go + rust (v7.7)', () => {
    assert.deepEqual([...SUPPORTED_STACKS].sort(), ['fastapi', 'go', 'node', 'python', 'rust']);
  });
});

describe('parseSpecFiles — stack hint extraction', () => {
  it('captures `fastapi` mention from prose (codex N3 / parser additions)', () => {
    const md = `## Files\n\n* \`src/myapp/main.py\` — uses fastapi to serve requests\n* \`tests/test_main.py\` — pytest case\n`;
    const parsed = parseSpecFiles(md)!;
    assert.equal(parsed.packageHints.stackHint, 'fastapi');
  });

  it('captures `python` mention but not when fastapi is also present (fastapi wins)', () => {
    const pythonOnly = parseSpecFiles(`## Files\n\n* \`src/foo.py\` — Python 3.12 module\n`)!;
    assert.equal(pythonOnly.packageHints.stackHint, 'python');
    const both = parseSpecFiles(`## Files\n\n* \`src/foo.py\` — Python 3.12 fastapi module\n`)!;
    assert.equal(both.packageHints.stackHint, 'fastapi');
  });
});

describe('--list-stacks output', () => {
  it('prints all three sections with the expected stack names (codex N2)', () => {
    // Capture console.log output by reassignment.
    const original = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    try {
      printStackList();
    } finally {
      console.log = original;
    }
    const joined = captured.join('\n');
    // Supported section + names.
    assert.match(joined, /Supported \(--stack accepts these\)/);
    assert.match(joined, /\bnode\b.*Node 22 ESM/);
    assert.match(joined, /\bpython\b.*Python 3\.11/);
    assert.match(joined, /\bfastapi\b.*FastAPI/);
    assert.match(joined, /\bgo\b.*Go 1\.22/);
    assert.match(joined, /\brust\b.*Rust 2021/);
    // Auto-detected section.
    assert.match(joined, /Auto-detected from `## Files`/);
    // Recognized-but-unsupported section.
    assert.match(joined, /Recognized-but-unsupported \(exit 3\)/);
    // v7.7 — only Ruby remains unsupported.
    assert.match(joined, /\bruby\b.*v7\.8/);
  });
});

// ---- CLI integration tests (invoke bin/claude-autopilot.js as subprocess).
//
// These exercise the dispatcher in src/cli/index.ts: --stack validation,
// --list-stacks, and the polyglot / unsupported exit-3 path. They use
// spawnSync (not execSync) to avoid shell injection on the spec path.

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

describe('CLI — scaffold flag handling', () => {
  it('--stack invalid → exit 3 with diagnostic', () => {
    const dir = makeTmp();
    const specPath = writeSpec(dir, NODE_SPEC);
    const r = runCli(['scaffold', '--from-spec', specPath, '--stack', 'erlang'], dir);
    assert.equal(r.status, 3, `expected exit 3, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /--stack "erlang" not recognized/);
    // v7.7 — list now includes go + rust.
    assert.match(r.stderr, /supported: node, python, fastapi, go, rust/);
    fs.rmSync(dir, { recursive: true });
  });

  it('--list-stacks prints the three sections and exits 0', () => {
    const dir = makeTmp();
    const r = runCli(['scaffold', '--list-stacks'], dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /Supported \(--stack accepts these\)/);
    assert.match(r.stdout, /Auto-detected from `## Files`/);
    assert.match(r.stdout, /Recognized-but-unsupported \(exit 3\)/);
    fs.rmSync(dir, { recursive: true });
  });

  it('Go spec → exit 0 (v7.6 — promoted from unsupported to supported)', () => {
    const dir = makeTmp();
    const specPath = writeSpec(dir, GO_SPEC);
    const r = runCli(['scaffold', '--from-spec', specPath], dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    // Should NOT generate Node/Python artifacts.
    assert.equal(fs.existsSync(path.join(dir, 'package.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'pyproject.toml')), false);
    // Should generate Go artifacts.
    assert.equal(fs.existsSync(path.join(dir, 'go.mod')), true);
    assert.equal(fs.existsSync(path.join(dir, 'main.go')), true);
    fs.rmSync(dir, { recursive: true });
  });

  it('v7.6 — lone go.mod spec detects as go', () => {
    const dir = makeTmp();
    const specPath = writeSpec(dir, `## Files\n\n* \`go.mod\` — module\n`);
    const r = runCli(['scaffold', '--from-spec', specPath], dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /stack: go/);
    fs.rmSync(dir, { recursive: true });
  });

  it('v7.6 — go.mod + package.json polyglot → exit 3 without --stack', () => {
    const dir = makeTmp();
    const specPath = writeSpec(
      dir,
      `## Files\n\n* \`go.mod\` — go side\n* \`package.json\` — node side\n`,
    );
    const r = runCli(['scaffold', '--from-spec', specPath], dir);
    assert.equal(r.status, 3, `expected exit 3, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /polyglot spec — pass --stack to disambiguate/);
    fs.rmSync(dir, { recursive: true });
  });

  it('polyglot spec without --stack → exit 3 (codex W3)', () => {
    const dir = makeTmp();
    const specPath = writeSpec(dir, POLYGLOT_SPEC);
    const r = runCli(['scaffold', '--from-spec', specPath], dir);
    assert.equal(r.status, 3, `expected exit 3, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /polyglot spec — pass --stack to disambiguate/);
    fs.rmSync(dir, { recursive: true });
  });

  it('--stack python on a polyglot spec warns + skips Node files (codex W5)', () => {
    const dir = makeTmp();
    const specPath = writeSpec(dir, POLYGLOT_SPEC);
    const r = runCli(['scaffold', '--from-spec', specPath, '--stack', 'python'], dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // package.json should NOT have been created.
    assert.equal(fs.existsSync(path.join(dir, 'package.json')), false);
    // pyproject.toml should have been created.
    assert.equal(fs.existsSync(path.join(dir, 'pyproject.toml')), true);
    // Diagnostic mentioned the skip (v7.6 wording: "ignoring non-Python files").
    assert.match(r.stdout, /ignoring non-Python files/);
    fs.rmSync(dir, { recursive: true });
  });
});
