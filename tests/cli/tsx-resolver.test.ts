// tests/cli/tsx-resolver.test.ts
//
// Unit tests for the v7.8.0 tsx resolver (spec
// docs/specs/v7.8.0-decouple-runtime-deps.md). Nine tests covering each
// branch of the precedence ladder, the two escape hatches, and the
// once-per-day deprecation warning + non-fatal state-dir behavior.

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { resolveTsx, stateDir, __TSX_DEPRECATION_MESSAGE } from '../../src/cli/tsx-resolver.ts';

// ---------------------------------------------------------------------------
// Test fixtures: temp dirs + tsx package fakes
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-resolver-test-'));

function makeProjectWithTsx(opts: { binShape: 'string' | 'object' }): string {
  const projectRoot = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'proj-'));
  // Create a faux installed tsx under node_modules/tsx
  const tsxDir = path.join(projectRoot, 'node_modules', 'tsx');
  fs.mkdirSync(tsxDir, { recursive: true });
  const binJs = path.join(tsxDir, 'cli.mjs');
  fs.writeFileSync(binJs, '// fake tsx bin\n', 'utf8');
  const bin = opts.binShape === 'string' ? './cli.mjs' : { tsx: './cli.mjs' };
  fs.writeFileSync(
    path.join(tsxDir, 'package.json'),
    JSON.stringify({ name: 'tsx', version: '0.0.0-test', bin }),
    'utf8',
  );
  // Project package.json (createRequire anchors here)
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fake-project', version: '0.0.0' }),
    'utf8',
  );
  return projectRoot;
}

function makeProjectWithoutTsx(): string {
  const projectRoot = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'noproj-'));
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'no-tsx', version: '0.0.0' }),
    'utf8',
  );
  return projectRoot;
}

function makePathDirWithTsx(): string {
  const dir = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'pathbin-'));
  fs.writeFileSync(path.join(dir, 'tsx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

/**
 * Windows-style fixture: only a `tsx.cmd` shim in the PATH dir (no bare
 * `tsx`). Mirrors `npm`'s shim layout on Windows. Used to validate the
 * `shell: true` opt-in for `.cmd`/`.bat` PATH hits.
 */
function makeWindowsPathDirWithTsxCmd(): string {
  const dir = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'winpath-'));
  fs.writeFileSync(path.join(dir, 'tsx.cmd'), '@echo off\nexit /b 0\n');
  return dir;
}

// Capture stderr writes so we can assert the deprecation warning fires.
function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  // Reassign with a permissive signature for tests; reset in `finally`.
  (process.stderr as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ) => {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  try {
    const result = fn();
    return { result, stderr: buf };
  } finally {
    process.stderr.write = orig;
  }
}

after(() => {
  try {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// Each test gets a fresh state dir so the once-per-day dedup doesn't bleed
// across tests.
function freshStateDir(): string {
  return fs.mkdtempSync(path.join(FIXTURE_ROOT, 'state-'));
}

// ---------------------------------------------------------------------------

describe('tsx-resolver: precedence ladder', () => {
  it('TR1: project-local tsx → returns project-local, no warning', () => {
    const projectRoot = makeProjectWithTsx({ binShape: 'object' });
    const { result, stderr } = captureStderr(() =>
      resolveTsx({
        projectRoot,
        env: { CLAUDE_AUTOPILOT_STATE_DIR: freshStateDir() },
        platform: 'linux',
      }),
    );
    assert.equal(result.source, 'project-local');
    assert.equal(result.command, process.execPath, 'spawn via node for portability');
    assert.equal(result.args.length, 1);
    const args0 = result.args[0] ?? '';
    assert.ok(
      args0.endsWith('cli.mjs'),
      `args[0] should point at the fake bin, got ${args0}`,
    );
    assert.equal(stderr, '', 'no deprecation warning when project-local hits');
  });

  it('TR2: project missing, PATH has tsx → returns path source, no warning', () => {
    const projectRoot = makeProjectWithoutTsx();
    const pathDir = makePathDirWithTsx();
    const { result, stderr } = captureStderr(() =>
      resolveTsx({
        projectRoot,
        env: {
          PATH: pathDir,
          CLAUDE_AUTOPILOT_STATE_DIR: freshStateDir(),
        },
        platform: 'linux',
      }),
    );
    assert.equal(result.source, 'path');
    assert.equal(result.command, path.join(pathDir, 'tsx'));
    assert.deepEqual(result.args, []);
    assert.equal(stderr, '', 'no deprecation warning when PATH hits');
  });

  it('TR3: both missing → returns bundled AND emits deprecation warning', () => {
    const projectRoot = makeProjectWithoutTsx();
    const { result, stderr } = captureStderr(() =>
      resolveTsx({
        projectRoot,
        env: {
          PATH: '/nonexistent/path/that/does/not/exist',
          CLAUDE_AUTOPILOT_STATE_DIR: freshStateDir(),
        },
        platform: 'linux',
      }),
    );
    assert.equal(result.source, 'bundled');
    assert.equal(result.command, process.execPath);
    assert.equal(result.args.length, 1);
    assert.ok(stderr.includes('[deprecation]'), `expected deprecation banner, got: ${stderr}`);
    assert.ok(
      stderr.includes('npm install -D tsx'),
      'banner should suggest installing tsx locally',
    );
  });
});

describe('tsx-resolver: package.json bin shapes', () => {
  it('TR4: bundled tsx with string-form bin → resolves correctly', () => {
    const projectRoot = makeProjectWithTsx({ binShape: 'string' });
    const result = resolveTsx({
      projectRoot,
      flagOverride: 'project',
      env: {},
      platform: 'linux',
      suppressWarning: true,
    });
    assert.equal(result.source, 'project-local');
    assert.equal(result.forcedBy, 'flag');
    assert.ok((result.args[0] ?? '').endsWith('cli.mjs'));
  });

  it('TR5: bundled tsx with object-form bin → resolves correctly', () => {
    const projectRoot = makeProjectWithTsx({ binShape: 'object' });
    const result = resolveTsx({
      projectRoot,
      flagOverride: 'project',
      env: {},
      platform: 'linux',
      suppressWarning: true,
    });
    assert.equal(result.source, 'project-local');
    assert.ok((result.args[0] ?? '').endsWith('cli.mjs'));
  });
});

describe('tsx-resolver: escape hatches', () => {
  it('TR6: CLAUDE_AUTOPILOT_TSX=bundled forces bundled, marks forcedBy=env, suppresses warning', () => {
    const projectRoot = makeProjectWithTsx({ binShape: 'object' });
    const { result, stderr } = captureStderr(() =>
      resolveTsx({
        projectRoot,
        envOverride: 'bundled',
        env: { CLAUDE_AUTOPILOT_STATE_DIR: freshStateDir() },
        platform: 'linux',
      }),
    );
    assert.equal(result.source, 'bundled');
    assert.equal(result.forcedBy, 'env');
    assert.equal(stderr, '', 'env-forced bundled should not emit warning');
  });

  it('TR7: --tsx-source=project forces project-local; missing project tsx throws', () => {
    const projectRoot = makeProjectWithTsx({ binShape: 'string' });
    const result = resolveTsx({
      projectRoot,
      flagOverride: 'project',
      env: {},
      platform: 'linux',
      suppressWarning: true,
    });
    assert.equal(result.source, 'project-local');
    assert.equal(result.forcedBy, 'flag');

    // Now the failure path
    const noProject = makeProjectWithoutTsx();
    assert.throws(
      () =>
        resolveTsx({
          projectRoot: noProject,
          flagOverride: 'project',
          env: {},
          platform: 'linux',
          suppressWarning: true,
        }),
      /tsx source=project requested via flag/,
      'should surface an actionable error',
    );
  });
});

describe('tsx-resolver: deprecation warning controls', () => {
  it('TR8: CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION=1 silences warning on bundled fallthrough', () => {
    const projectRoot = makeProjectWithoutTsx();
    const { result, stderr } = captureStderr(() =>
      resolveTsx({
        projectRoot,
        env: {
          PATH: '/nonexistent/dir',
          CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION: '1',
          CLAUDE_AUTOPILOT_STATE_DIR: freshStateDir(),
        },
        platform: 'linux',
      }),
    );
    assert.equal(result.source, 'bundled');
    assert.equal(stderr, '', 'no warning when opt-out env var is set');
  });

  it('TR9: readonly state dir → warning still prints (non-fatal dedup)', () => {
    // Point dedup at a path inside a real file (mkdir + write will throw).
    // Tactic: use a state dir whose parent is a regular file — mkdirSync
    // recursive will fail.
    const fileAsDir = path.join(FIXTURE_ROOT, 'as-file-' + Math.random().toString(36).slice(2));
    fs.writeFileSync(fileAsDir, 'not-a-dir', 'utf8');
    const projectRoot = makeProjectWithoutTsx();

    const { result, stderr } = captureStderr(() =>
      resolveTsx({
        projectRoot,
        env: {
          PATH: '/nonexistent/dir',
          // Place the state dir as a CHILD of the regular file → mkdir fails.
          CLAUDE_AUTOPILOT_STATE_DIR: path.join(fileAsDir, 'state'),
        },
        platform: 'linux',
      }),
    );
    assert.equal(result.source, 'bundled');
    assert.ok(
      stderr.includes('[deprecation]'),
      `warning should still print even when state dir write fails, got: ${stderr}`,
    );
  });
});

describe('tsx-resolver: stateDir helper (A7 / XDG)', () => {
  it('stateDir respects CLAUDE_AUTOPILOT_STATE_DIR override', () => {
    assert.equal(
      stateDir({ CLAUDE_AUTOPILOT_STATE_DIR: '/tmp/custom' }, 'linux'),
      '/tmp/custom',
    );
  });
  it('stateDir uses XDG_STATE_HOME on POSIX when set', () => {
    assert.equal(
      stateDir({ XDG_STATE_HOME: '/var/lib/xdg' }, 'linux'),
      path.join('/var/lib/xdg', 'claude-autopilot'),
    );
  });
  it('stateDir falls back to ~/.claude-autopilot on POSIX without XDG', () => {
    assert.equal(
      stateDir({}, 'linux'),
      path.join(os.homedir(), '.claude-autopilot'),
    );
  });
  it('stateDir on Windows ignores XDG_STATE_HOME', () => {
    assert.equal(
      stateDir({ XDG_STATE_HOME: '/var/lib/xdg' }, 'win32'),
      path.join(os.homedir(), '.claude-autopilot'),
    );
  });
});

describe('tsx-resolver: A3 self-pointer check', () => {
  it('PATH-resolved bin inside our own node_modules → treated as bundled', () => {
    // Resolve our own bundled tsx via the normal path so we know its dir.
    const projectRoot = makeProjectWithoutTsx();
    const bundled = resolveTsx({
      projectRoot,
      envOverride: 'bundled',
      env: {},
      platform: 'linux',
      suppressWarning: true,
    });
    // Point PATH at the directory containing the bundled tsx bin.
    const bundledDir = path.dirname(bundled.args[0] ?? '');

    const { result, stderr } = captureStderr(() =>
      resolveTsx({
        projectRoot,
        env: {
          PATH: bundledDir,
          CLAUDE_AUTOPILOT_STATE_DIR: freshStateDir(),
        },
        platform: 'linux',
      }),
    );
    assert.equal(
      result.source,
      'bundled',
      'PATH pointing at our own bundled tsx should fall through to "bundled"',
    );
    assert.ok(
      stderr.includes('[deprecation]'),
      'and the deprecation warning should still fire',
    );
  });
});

describe('tsx-resolver: Windows .cmd shim handling', () => {
  it('TR10: PATH-hit on tsx.cmd (win32) → returns shell: true', () => {
    const projectRoot = makeProjectWithoutTsx();
    const winPathDir = makeWindowsPathDirWithTsxCmd();
    const { result, stderr } = captureStderr(() =>
      resolveTsx({
        projectRoot,
        env: {
          PATH: winPathDir,
          PATHEXT: '.EXE;.CMD',
          CLAUDE_AUTOPILOT_STATE_DIR: freshStateDir(),
        },
        platform: 'win32',
      }),
    );
    assert.equal(result.source, 'path');
    assert.equal(
      result.shell,
      true,
      '.cmd shims require shell: true on Windows — spawn() cannot launch them directly',
    );
    assert.ok(
      result.command.toLowerCase().endsWith('tsx.cmd'),
      `expected .cmd shim path, got: ${result.command}`,
    );
    assert.equal(stderr, '', 'PATH hit should not emit deprecation warning');
  });

  it('TR11: PATH-hit on plain tsx (linux) → shell unset', () => {
    const projectRoot = makeProjectWithoutTsx();
    const pathDir = makePathDirWithTsx();
    const { result } = captureStderr(() =>
      resolveTsx({
        projectRoot,
        env: {
          PATH: pathDir,
          CLAUDE_AUTOPILOT_STATE_DIR: freshStateDir(),
        },
        platform: 'linux',
      }),
    );
    assert.equal(result.source, 'path');
    assert.equal(result.shell, undefined, 'POSIX shebang exec does not need shell');
  });

  it('TR12: bundled/project-local resolution → shell unset (runs via node)', () => {
    const projectRoot = makeProjectWithTsx({ binShape: 'object' });
    const { result } = captureStderr(() =>
      resolveTsx({
        projectRoot,
        env: { CLAUDE_AUTOPILOT_STATE_DIR: freshStateDir() },
        platform: 'win32', // even on Windows, we exec node <bin.js> directly
      }),
    );
    assert.equal(result.source, 'project-local');
    assert.equal(result.command, process.execPath);
    assert.equal(result.shell, undefined, 'node + bin.js needs no shell');
  });
});

// Smoke: the message constant is non-empty and includes the key opt-out hint.
describe('tsx-resolver: deprecation message constant', () => {
  it('message includes the silence env var name', () => {
    assert.ok(__TSX_DEPRECATION_MESSAGE.includes('CLAUDE_AUTOPILOT_NO_TSX_DEPRECATION'));
    assert.ok(__TSX_DEPRECATION_MESSAGE.includes('CLAUDE_AUTOPILOT_TSX'));
  });
});

// Silence linter: imports we don't reference (before/afterEach reserved for
// future expansion); use them as a no-op to keep TS happy if needed.
void before;
void afterEach;
