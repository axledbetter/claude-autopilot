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

  it('returns "unsupported" for a Go spec (codex W2 — exit 3, no silent Node fallback)', () => {
    const parsed = parseSpecFiles(GO_SPEC)!;
    const result = detectStack(parsed);
    assert.equal(result.kind, 'unsupported');
    if (result.kind === 'unsupported') {
      assert.equal(result.stack, 'go');
      assert.match(result.message, /go detected but not supported until v7\.5/);
    }
  });

  it('returns "polyglot" when both package.json + pyproject.toml are listed without --stack (codex W3)', () => {
    const parsed = parseSpecFiles(POLYGLOT_SPEC)!;
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

  it('also flags Rust (Cargo.toml) and Ruby (Gemfile) as detected-but-unsupported', () => {
    const rustParsed = parseSpecFiles(RUST_SPEC)!;
    const rustResult = detectStack(rustParsed);
    assert.equal(rustResult.kind, 'unsupported');
    if (rustResult.kind === 'unsupported') assert.equal(rustResult.stack, 'rust');

    const rubyParsed = parseSpecFiles(RUBY_SPEC)!;
    const rubyResult = detectStack(rubyParsed);
    assert.equal(rubyResult.kind, 'unsupported');
    if (rubyResult.kind === 'unsupported') assert.equal(rubyResult.stack, 'ruby');
  });
});

describe('--stack override', () => {
  it('forces python even when path heuristics would pick node', () => {
    const parsed = parseSpecFiles(NODE_SPEC)!;
    const result = detectStack(parsed, 'python');
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.stack, 'python');
  });

  it('SUPPORTED_STACKS lists exactly node + python + fastapi', () => {
    assert.deepEqual([...SUPPORTED_STACKS].sort(), ['fastapi', 'node', 'python']);
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
    // Auto-detected section.
    assert.match(joined, /Auto-detected from `## Files`/);
    // Recognized-but-unsupported section.
    assert.match(joined, /Recognized-but-unsupported \(exit 3\)/);
    assert.match(joined, /\bgo\b.*v7\.5/);
    assert.match(joined, /\brust\b.*v7\.5/);
    assert.match(joined, /\bruby\b.*v7\.5/);
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

  it('Go spec → exit 3 (codex W2: no silent fallback to Node)', () => {
    const dir = makeTmp();
    const specPath = writeSpec(dir, GO_SPEC);
    const r = runCli(['scaffold', '--from-spec', specPath], dir);
    assert.equal(r.status, 3, `expected exit 3, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /go detected but not supported until v7\.5/);
    // Ensure NOTHING was generated — no package.json, no pyproject.toml.
    assert.equal(fs.existsSync(path.join(dir, 'package.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'pyproject.toml')), false);
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
    // Diagnostic mentioned the skip.
    assert.match(r.stdout, /ignoring Node files/);
    fs.rmSync(dir, { recursive: true });
  });
});
