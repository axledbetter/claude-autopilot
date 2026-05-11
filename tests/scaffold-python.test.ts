// v7.4.0 — Python + FastAPI scaffolder tests.
//
// Covers:
//   - name normalization (codex W1): my-pkg-2 -> my_pkg_2; 2cool -> _2cool
//   - bare Python end-to-end (pyproject.toml shape, init.py created)
//   - Python with explicit dep hints (verbatim, no version inference)
//   - FastAPI end-to-end:
//     * fastapi + uvicorn[standard] auto-included (codex W6)
//     * src/<pkg>/main.py generated (codex C2 — entrypoint must resolve)
//     * tests/test_main.py generated (otherwise pytest config block is dead)
//     * [tool.hatch.build.targets.wheel] packages = ["src/<pkg>"] (codex W1)
//     * [project.scripts] <dist>-server entry present
//   - dep-extraction dedup (codex W6): fastapi twice -> appears once
//   - integration smoke (codex N3): pip install -e . + import app
//     SKIPPED when python3 not on PATH, so local devs without Python see SKIP

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  buildPyproject,
  buildPythonDependencies,
  dependencyNameKey,
  normalizeDistributionName,
  packageNameFromDistribution,
} from '../src/cli/scaffold/python.ts';
import { runScaffold } from '../src/cli/scaffold.ts';

function makeTmp(name?: string): string {
  // Allow caller to pin the basename so the distribution-name normalization
  // tests can exercise specific cases (e.g., "my-pkg-2", "2cool"). We mkdtemp
  // a parent then mkdir the named child inside.
  if (name) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-pyparent-'));
    const child = path.join(parent, name);
    fs.mkdirSync(child, { recursive: true });
    return child;
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-py-'));
}

function writeSpec(dir: string, body: string): string {
  const p = path.join(dir, 'spec.md');
  fs.writeFileSync(p, body);
  return p;
}

function readPyproject(dir: string): string {
  return fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
}

// ---- Pure-function unit tests.

describe('name normalization (codex W1)', () => {
  it('my-pkg-2 → distribution my-pkg-2, package my_pkg_2', () => {
    const dist = normalizeDistributionName('my-pkg-2');
    assert.equal(dist, 'my-pkg-2');
    assert.equal(packageNameFromDistribution(dist), 'my_pkg_2');
  });

  it('2cool → distribution 2cool, package _2cool (digit-prefix guard)', () => {
    const dist = normalizeDistributionName('2cool');
    assert.equal(dist, '2cool');
    assert.equal(packageNameFromDistribution(dist), '_2cool');
  });

  it('My.Package_v2 → lowercase + collapsed separators (PEP 503-ish)', () => {
    const dist = normalizeDistributionName('My.Package_v2');
    assert.equal(dist, 'my-package-v2');
    assert.equal(packageNameFromDistribution(dist), 'my_package_v2');
  });

  it('empty / dash-only basename → falls back to "app"', () => {
    assert.equal(normalizeDistributionName('---'), 'app');
    assert.equal(normalizeDistributionName(''), 'app');
  });
});

describe('dependency dedup (codex W6)', () => {
  it('dependencyNameKey strips version specifier and extras', () => {
    assert.equal(dependencyNameKey('fastapi'), 'fastapi');
    assert.equal(dependencyNameKey('fastapi>=0.110'), 'fastapi');
    assert.equal(dependencyNameKey('uvicorn[standard]>=0.27'), 'uvicorn');
    assert.equal(dependencyNameKey('Django'), 'django');
  });

  it('buildPythonDependencies dedupes by normalized name; first occurrence wins', () => {
    const out = buildPythonDependencies(
      ['fastapi==0.115', 'requests', 'fastapi>=0.110'],
      false,
    );
    assert.deepEqual(out, ['fastapi==0.115', 'requests']);
  });

  it('buildPythonDependencies in FastAPI mode auto-includes fastapi + uvicorn[standard]', () => {
    const out = buildPythonDependencies(undefined, true);
    assert.deepEqual(out, ['fastapi>=0.110', 'uvicorn[standard]>=0.27']);
  });

  it('buildPythonDependencies in FastAPI mode does NOT override an existing fastapi pin', () => {
    const out = buildPythonDependencies(['fastapi==0.115'], true);
    // fastapi==0.115 stays first; auto-default is suppressed by dedup.
    // uvicorn still added.
    assert.deepEqual(out, ['fastapi==0.115', 'uvicorn[standard]>=0.27']);
  });
});

describe('buildPyproject shape', () => {
  it('emits hatchling explicit packages line (codex W1)', () => {
    const body = buildPyproject({
      distributionName: 'my-app',
      packageName: 'my_app',
      dependencies: ['requests'],
      isFastapi: false,
    });
    assert.match(body, /\[tool\.hatch\.build\.targets\.wheel\]/);
    assert.match(body, /packages = \["src\/my_app"\]/);
  });

  it('FastAPI mode adds [project.scripts] entry pointing at packageName.main:run', () => {
    const body = buildPyproject({
      distributionName: 'my-app',
      packageName: 'my_app',
      dependencies: ['fastapi>=0.110', 'uvicorn[standard]>=0.27'],
      isFastapi: true,
    });
    assert.match(body, /\[project\.scripts\]/);
    assert.match(body, /my-app-server = "my_app\.main:run"/);
  });

  it('non-FastAPI mode omits [project.scripts]', () => {
    const body = buildPyproject({
      distributionName: 'my-app',
      packageName: 'my_app',
      dependencies: [],
      isFastapi: false,
    });
    assert.equal(body.includes('[project.scripts]'), false);
  });
});

// ---- Integration tests: runScaffold end-to-end.

describe('runScaffold (Python end-to-end)', () => {
  it('bare Python: writes pyproject.toml + src/<pkg>/__init__.py + README.md', async () => {
    const dir = makeTmp('myapp');
    const specPath = writeSpec(
      dir,
      `## Files\n\n* \`pyproject.toml\` — PEP 621 hatchling\n* \`src/myapp/core.py\` — pure module\n`,
    );
    const result = await runScaffold({ cwd: dir, specPath });
    assert.equal(result.stack, 'python');
    // Files we generated.
    assert.equal(fs.existsSync(path.join(dir, 'pyproject.toml')), true);
    assert.equal(fs.existsSync(path.join(dir, 'src/myapp/__init__.py')), true);
    assert.equal(fs.existsSync(path.join(dir, 'README.md')), true);
    // Spec-listed empty placeholder.
    assert.equal(fs.existsSync(path.join(dir, 'src/myapp/core.py')), true);
    assert.equal(fs.readFileSync(path.join(dir, 'src/myapp/core.py'), 'utf8'), '');
    // pyproject shape.
    const pp = readPyproject(dir);
    assert.match(pp, /name = "myapp"/);
    assert.match(pp, /requires-python = ">=3\.11"/);
    assert.match(pp, /\[build-system\]/);
    assert.match(pp, /requires = \["hatchling"\]/);
    assert.match(pp, /packages = \["src\/myapp"\]/);
    assert.match(pp, /\[tool\.pytest\.ini_options\]/);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('Python with explicit dep hints — verbatim, no version inference', async () => {
    const dir = makeTmp('depsapp');
    const specPath = writeSpec(
      dir,
      `## Files\n\n* \`pyproject.toml\` — \`dependencies: [requests, pydantic>=2, click]\`\n* \`src/depsapp/cli.py\` — entry\n`,
    );
    await runScaffold({ cwd: dir, specPath });
    const pp = readPyproject(dir);
    assert.match(pp, /"requests"/);
    assert.match(pp, /"pydantic>=2"/);
    assert.match(pp, /"click"/);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('FastAPI end-to-end: auto-includes fastapi+uvicorn, generates main.py + test_main.py (codex C2)', async () => {
    const dir = makeTmp('fapi');
    const specPath = writeSpec(
      dir,
      `## Files\n\n* \`pyproject.toml\` — fastapi project\n* \`src/fapi/main.py\` — fastapi app + /health\n`,
    );
    const result = await runScaffold({ cwd: dir, specPath });
    assert.equal(result.stack, 'fastapi');
    // Generated artifacts.
    const mainPath = path.join(dir, 'src/fapi/main.py');
    const testPath = path.join(dir, 'tests/test_main.py');
    assert.equal(fs.existsSync(mainPath), true, 'src/fapi/main.py exists');
    assert.equal(fs.existsSync(testPath), true, 'tests/test_main.py exists');
    // main.py contains the FastAPI app + /health + run().
    const mainBody = fs.readFileSync(mainPath, 'utf8');
    assert.match(mainBody, /from fastapi import FastAPI/);
    assert.match(mainBody, /app = FastAPI\(\)/);
    assert.match(mainBody, /@app\.get\("\/health"\)/);
    assert.match(mainBody, /def run\(\)/);
    assert.match(mainBody, /uvicorn\.run\("fapi\.main:app"/);
    // test_main.py contains a test that hits /health.
    const testBody = fs.readFileSync(testPath, 'utf8');
    assert.match(testBody, /from fastapi\.testclient import TestClient/);
    assert.match(testBody, /from fapi\.main import app/);
    assert.match(testBody, /assert response\.status_code == 200/);
    // pyproject auto-includes fastapi + uvicorn[standard], plus the
    // hatchling explicit-packages block (codex W1) and the
    // [project.scripts] entry (codex C2).
    const pp = readPyproject(dir);
    assert.match(pp, /"fastapi>=0\.110"/);
    assert.match(pp, /"uvicorn\[standard\]>=0\.27"/);
    assert.match(pp, /\[project\.scripts\]/);
    assert.match(pp, /fapi-server = "fapi\.main:run"/);
    assert.match(pp, /packages = \["src\/fapi"\]/);
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('FastAPI dep dedup (codex W6): spec lists fastapi twice → appears once in pyproject', async () => {
    const dir = makeTmp('dedup');
    const specPath = writeSpec(
      dir,
      `## Files\n\n* \`pyproject.toml\` — \`dependencies: [fastapi==0.115, fastapi]\` fastapi project\n* \`src/dedup/main.py\` — entry\n`,
    );
    await runScaffold({ cwd: dir, specPath });
    const pp = readPyproject(dir);
    // Count occurrences of `fastapi` as a quoted dependency string.
    // Should be exactly 1 (the explicit pin from the spec wins; the
    // auto-default is suppressed by dedup).
    const matches = pp.match(/"fastapi[^"]*"/g) ?? [];
    assert.equal(matches.length, 1, `expected 1 fastapi entry, got ${matches.length}: ${matches.join(', ')}`);
    assert.equal(matches[0], '"fastapi==0.115"');
    fs.rmSync(path.dirname(dir), { recursive: true });
  });

  it('never overwrites an existing pyproject.toml or README.md', async () => {
    const dir = makeTmp('preserve');
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '# preexisting\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# preexisting readme\n');
    const specPath = writeSpec(
      dir,
      `## Files\n\n* \`pyproject.toml\` — would-be-new\n* \`src/preserve/__init__.py\` — pkg\n`,
    );
    const result = await runScaffold({ cwd: dir, specPath });
    assert.equal(result.stack, 'python');
    assert.equal(
      fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'),
      '# preexisting\n',
    );
    assert.equal(
      fs.readFileSync(path.join(dir, 'README.md'), 'utf8'),
      '# preexisting readme\n',
    );
    fs.rmSync(path.dirname(dir), { recursive: true });
  });
});

// ---- Integration test (codex N3): pip install -e . + importlib check.
//
// We use spawnSync (no shell) with python3 + pip + python3 -c and pass
// the package name as a separate argv entry so there's no possibility of
// shell injection from the tmpdir path.
//
// Skipped automatically when python3 is not on PATH so local developers
// without Python installed see SKIP, not FAIL. CI Ubuntu has python3.

function hasPython3(): boolean {
  try {
    const r = spawnSync('python3', ['--version'], { stdio: 'pipe' });
    return r.status === 0;
  } catch {
    return false;
  }
}

const PYTHON_AVAILABLE = hasPython3();

describe('FastAPI integration (codex N3)', () => {
  it(
    'scaffolds + pip install -e . + import app',
    { skip: !PYTHON_AVAILABLE ? 'python3 not on PATH' : false },
    async () => {
      const dir = makeTmp('intgr');
      const specPath = writeSpec(
        dir,
        `## Files\n\n* \`pyproject.toml\` — fastapi\n* \`src/intgr/main.py\` — fastapi app\n`,
      );
      await runScaffold({ cwd: dir, specPath });

      // Create an isolated venv so we don't pollute system site-packages
      // (and so the test works on systems with PEP 668 externally-managed
      // Python). If venv creation fails for any reason (rare), bail with a
      // clear message rather than a confusing pip error.
      const venvDir = path.join(dir, '.venv');
      const venvCreate = spawnSync('python3', ['-m', 'venv', venvDir], { stdio: 'pipe' });
      if (venvCreate.status !== 0) {
        // Treat venv creation failure as a skip (some CI sandboxes block it).
        const err = venvCreate.stderr?.toString() ?? '';
        console.log(`# SKIP: python3 -m venv failed: ${err.slice(0, 200)}`);
        fs.rmSync(path.dirname(dir), { recursive: true, force: true });
        return;
      }
      const venvPython = path.join(venvDir, 'bin', 'python3');

      // pip install -e . — install the scaffolded package + its deps.
      // 5min timeout (pip downloading fastapi + uvicorn + pydantic on a
      // cold venv takes ~30-60s on broadband; CI runners are slower).
      const install = spawnSync(
        venvPython,
        ['-m', 'pip', 'install', '--quiet', '-e', '.'],
        { cwd: dir, stdio: 'pipe', timeout: 300_000 },
      );
      if (install.status !== 0) {
        const err = install.stderr?.toString() ?? '';
        // Network failures / PyPI unavailable shouldn't fail the suite —
        // log + skip.
        if (/Could not (?:fetch|find|resolve)|Network|temporary failure/i.test(err)) {
          console.log(`# SKIP: pip install network failure: ${err.slice(0, 200)}`);
          fs.rmSync(path.dirname(dir), { recursive: true, force: true });
          return;
        }
        assert.fail(`pip install failed (status ${install.status}):\n${err.slice(0, 800)}`);
      }

      // Import-check: print(intgr.main.app). Returns "<fastapi.applications.FastAPI ...>"
      // when the entrypoint resolves. If main.py is missing or [project.scripts]
      // points at something that doesn't exist, this fails — which is exactly
      // the regression codex C2 was about.
      const importCheck = spawnSync(
        venvPython,
        ['-c', 'import intgr.main; print(intgr.main.app)'],
        { cwd: dir, stdio: 'pipe' },
      );
      assert.equal(
        importCheck.status,
        0,
        `import check failed:\nstdout: ${importCheck.stdout}\nstderr: ${importCheck.stderr}`,
      );
      assert.match(importCheck.stdout?.toString() ?? '', /FastAPI/);

      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    },
  );
});

// Reference execFileSync to silence "imported but unused" if we ever
// trim the integration test back to the stub form.
void execFileSync;
