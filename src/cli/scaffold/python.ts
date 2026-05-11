// v7.4.0 — Python + FastAPI scaffolder.
//
// Two scaffold flavors share most of this module:
//   - bare Python (pyproject.toml / requirements.txt detected)
//   - FastAPI (Python + a main.py + a `fastapi` mention in the spec)
//
// FastAPI auto-includes `fastapi>=0.110` and `uvicorn[standard]>=0.27` in
// dependencies (deduped by PEP 503 normalized name) and emits a runnable
// `src/<package>/main.py` + `tests/test_main.py` so the generated
// `[project.scripts]` entrypoint actually resolves on `pip install -e .`
// — not a dangling stub. This was codex CRITICAL #2 on the v7.4.0 spec.
//
// All naming follows the deterministic algorithm described in the spec
// ("Name normalization (codex WARNING #1)"):
//   - distribution_name = PEP 503 normalize(basename(cwd))
//   - package_name = distribution_name with `-`/`.` -> `_`,
//                    prefix `_` if it would start with a digit.

import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';

import type { ParsedFiles, ScaffoldResult, ScaffoldRunContext } from './types.ts';

const PASS = '\x1b[32m✓\x1b[0m';
const SKIP = '\x1b[2m·\x1b[0m';
const DIM  = (t: string) => `\x1b[2m${t}\x1b[0m`;

/**
 * PEP 503 distribution-name normalization, restricted to what we need
 * here. Lowercase, runs of `[._-]+` collapse to a single `-`, leading +
 * trailing `[._-]` stripped. Empty result falls back to 'app' (so the
 * worst-case `cwd` of `___` still produces a buildable pyproject).
 */
export function normalizeDistributionName(raw: string): string {
  const lower = raw.toLowerCase();
  const collapsed = lower.replace(/[._-]+/g, '-');
  const stripped = collapsed.replace(/^[-]+/, '').replace(/[-]+$/, '');
  return stripped.length > 0 ? stripped : 'app';
}

/**
 * Convert a (PEP 503 normalized) distribution name into a valid Python
 * identifier suitable for a top-level package directory:
 *   - replace `-` and `.` with `_`
 *   - prefix `_` if it starts with a digit (so `2cool` -> `_2cool`)
 *
 * Tests pin both transformations:
 *   my-pkg-2 -> my_pkg_2
 *   2cool    -> _2cool
 */
export function packageNameFromDistribution(distribution: string): string {
  const replaced = distribution.replace(/[-.]/g, '_');
  return /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
}

/**
 * Parse a dependency string (`fastapi`, `fastapi>=0.110`,
 * `uvicorn[standard]`, `pyramid==2.0`) into its PEP 503 normalized
 * "name" portion — used purely as a dedup key. We don't care about the
 * version specifier when keying; first-occurrence wins (per spec
 * "Dedupe by PEP 503 normalized name; first occurrence wins").
 */
export function dependencyNameKey(dep: string): string {
  // Strip extras + version specifier. Match the leading
  // identifier (PEP 508 names are `[A-Za-z0-9._-]+`).
  const m = /^[A-Za-z0-9._-]+/.exec(dep.trim());
  if (!m) return dep.trim().toLowerCase();
  return normalizeDistributionName(m[0]);
}

/**
 * Build the dependency list for the generated pyproject.toml. Honors
 * the narrow contract from spec ("Dependency hint extraction (codex
 * WARNING #6)"): values flow through verbatim, no version inference,
 * deduped by PEP 503 normalized name. For FastAPI we ALSO seed
 * `fastapi>=0.110` and `uvicorn[standard]>=0.27` if not already present.
 */
export function buildPythonDependencies(
  hintDeps: string[] | undefined,
  isFastapi: boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const key = dependencyNameKey(raw);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(raw);
  };

  for (const d of hintDeps ?? []) push(d);

  if (isFastapi) {
    // Only auto-add when not already supplied. If the spec listed
    // `fastapi==0.115`, we keep that pin and don't override it with our
    // default lower bound.
    push('fastapi>=0.110');
    push('uvicorn[standard]>=0.27');
  }

  return out;
}

/**
 * Format a TOML string array, one entry per line. Used for the
 * `dependencies = [...]` block in pyproject.toml. Strings are quoted
 * with double quotes; we escape backslashes + double quotes.
 */
function tomlStringArray(values: string[]): string {
  if (values.length === 0) return '[]';
  const lines = values.map(v => `    "${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `[\n${lines.join(',\n')},\n]`;
}

/**
 * Generate the pyproject.toml body. Caller supplies the resolved
 * distribution name, package name, dependency list, and FastAPI flag
 * (only difference: FastAPI adds a `[project.scripts]` block).
 */
export function buildPyproject(opts: {
  distributionName: string;
  packageName: string;
  dependencies: string[];
  isFastapi: boolean;
}): string {
  const { distributionName, packageName, dependencies, isFastapi } = opts;
  const lines: string[] = [];
  lines.push('[project]');
  lines.push(`name = "${distributionName}"`);
  lines.push('version = "0.1.0"');
  lines.push('requires-python = ">=3.11"');
  lines.push(`dependencies = ${tomlStringArray(dependencies)}`);
  lines.push('');
  if (isFastapi) {
    lines.push('[project.scripts]');
    lines.push(`${distributionName}-server = "${packageName}.main:run"`);
    lines.push('');
  }
  lines.push('[build-system]');
  lines.push('requires = ["hatchling"]');
  lines.push('build-backend = "hatchling.build"');
  lines.push('');
  // codex W1 — explicit packages list, no auto-discovery.
  lines.push('[tool.hatch.build.targets.wheel]');
  lines.push(`packages = ["src/${packageName}"]`);
  lines.push('');
  lines.push('[tool.pytest.ini_options]');
  lines.push('testpaths = ["tests"]');
  lines.push('');
  return lines.join('\n');
}

/** FastAPI entrypoint — codex CRITICAL #2: must be runnable, not a stub. */
export function buildFastapiMain(packageName: string): string {
  return `"""FastAPI entrypoint — auto-scaffolded by claude-autopilot.
Override the prose docstring + add real routes; keep \`app\` and
\`run()\` exported so the [project.scripts] entry stays valid.
"""
from fastapi import FastAPI
import uvicorn

app = FastAPI()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def run() -> None:
    uvicorn.run("${packageName}.main:app", host="0.0.0.0", port=8000)
`;
}

/** Smoke test for the FastAPI scaffold — also auto-included so pytest config isn't dead. */
export function buildFastapiTest(packageName: string): string {
  return `from fastapi.testclient import TestClient
from ${packageName}.main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
`;
}

/** Generic Python README placeholder. Never overwrites an existing README. */
function buildReadme(distributionName: string, isFastapi: boolean): string {
  const stackLabel = isFastapi ? 'FastAPI' : 'Python';
  return `# ${distributionName}

${stackLabel} project scaffolded by \`claude-autopilot scaffold --from-spec\`.

## Install

\`\`\`bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
\`\`\`

## Test

\`\`\`bash
pytest
\`\`\`
`;
}

/**
 * The Python scaffolder. Materializes:
 *   - src/<package_name>/__init__.py (empty)
 *   - tests/ directory
 *   - pyproject.toml (PEP 621 + hatchling)
 *   - README.md (only if missing)
 *
 * For FastAPI specs it also writes:
 *   - src/<package_name>/main.py (runnable FastAPI app)
 *   - tests/test_main.py (smoke test)
 *
 * Files explicitly listed in the spec's `## Files` get touched as empty
 * placeholders if they don't already exist (matches the v7.2.0 Node
 * behavior). The special files above are written with content even when
 * not listed in `## Files` — without them the generated pyproject.toml
 * is invalid (missing package dir) or has dead config (no tests).
 */
/**
 * Extract the Python package name from a spec's `## Files` paths if the
 * spec lists a `src/<pkg>/<*>.py` entry. Returns null if no spec-derived
 * package name is present — caller falls back to the cwd-derived default.
 *
 * v7.4.3 hotfix — the v7.4.0 scaffolder always used basename(cwd) and
 * ignored spec-listed src/<pkg>/ paths, producing two competing trees
 * (one auto-generated, one empty placeholder from the spec).
 */
export function packageNameFromSpec(parsed: ParsedFiles): string | null {
  for (const p of parsed.paths) {
    const m = /^src\/([a-zA-Z_][a-zA-Z0-9_]*)\/[^/]+\.py$/.exec(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

export async function scaffoldPython(
  ctx: ScaffoldRunContext,
  opts: { isFastapi: boolean },
): Promise<ScaffoldResult> {
  const { cwd, parsed, dryRun } = ctx;
  const { isFastapi } = opts;

  // v7.4.3: prefer spec-derived package name; fall back to cwd basename.
  const specPackage = packageNameFromSpec(parsed);
  const distributionName = normalizeDistributionName(path.basename(cwd));
  const packageName = specPackage ?? packageNameFromDistribution(distributionName);

  const filesCreated: string[] = [];
  const filesSkippedExisting: string[] = [];
  const dirsCreated: string[] = [];

  // We treat these as "managed" — we generate them with content, not
  // empty placeholders, so the spec's bullet-list entries for them
  // don't get touched first.
  const MANAGED_FILES = new Set<string>([
    'pyproject.toml',
    'requirements.txt', // we don't generate this, but if listed we leave it
    `src/${packageName}/__init__.py`,
    `src/${packageName}/main.py`,
    'tests/test_main.py',
    'README.md',
  ]);

  // 1) Create directories. Always include the package + tests dirs;
  //    plus any dirs implied by spec paths.
  const dirs = new Set<string>([`src/${packageName}`, 'tests']);
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

  // 2) Touch placeholder files for any spec paths we don't manage.
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

  // 3) src/<package_name>/__init__.py
  const initRel = `src/${packageName}/__init__.py`;
  const initAbs = path.join(cwd, initRel);
  if (fs.existsSync(initAbs)) {
    filesSkippedExisting.push(initRel);
    console.log(`  ${SKIP}  exists  ${DIM(initRel)}`);
  } else {
    if (!dryRun) await fsAsync.writeFile(initAbs, '', 'utf8');
    filesCreated.push(initRel);
    console.log(`  ${PASS}  touch   ${DIM(initRel)}`);
  }

  // 4) FastAPI-only: main.py + tests/test_main.py
  if (isFastapi) {
    const mainRel = `src/${packageName}/main.py`;
    const mainAbs = path.join(cwd, mainRel);
    if (fs.existsSync(mainAbs)) {
      filesSkippedExisting.push(mainRel);
      console.log(`  ${SKIP}  exists  ${DIM(mainRel)}`);
    } else {
      if (!dryRun) await fsAsync.writeFile(mainAbs, buildFastapiMain(packageName), 'utf8');
      filesCreated.push(mainRel);
      console.log(`  ${PASS}  write   ${DIM(`${mainRel} (FastAPI app + /health + run())`)}`);
    }

    const testRel = 'tests/test_main.py';
    const testAbs = path.join(cwd, testRel);
    if (fs.existsSync(testAbs)) {
      filesSkippedExisting.push(testRel);
      console.log(`  ${SKIP}  exists  ${DIM(testRel)}`);
    } else {
      if (!dryRun) await fsAsync.writeFile(testAbs, buildFastapiTest(packageName), 'utf8');
      filesCreated.push(testRel);
      console.log(`  ${PASS}  write   ${DIM(`${testRel} (smoke test for /health)`)}`);
    }
  }

  // 5) pyproject.toml
  const pyprojectAbs = path.join(cwd, 'pyproject.toml');
  if (fs.existsSync(pyprojectAbs)) {
    filesSkippedExisting.push('pyproject.toml');
    console.log(`  ${SKIP}  exists  ${DIM('pyproject.toml (preserved)')}`);
  } else {
    const dependencies = buildPythonDependencies(parsed.packageHints.pythonDeps, isFastapi);
    const body = buildPyproject({ distributionName, packageName, dependencies, isFastapi });
    if (!dryRun) await fsAsync.writeFile(pyprojectAbs, body, 'utf8');
    filesCreated.push('pyproject.toml');
    const flavor = isFastapi ? 'PEP 621 + hatchling + FastAPI deps' : 'PEP 621 + hatchling';
    console.log(`  ${PASS}  write   ${DIM(`pyproject.toml (${flavor})`)}`);
  }

  // 6) README.md — codex NOTE #1 (always create, never overwrite).
  const readmeAbs = path.join(cwd, 'README.md');
  if (fs.existsSync(readmeAbs)) {
    filesSkippedExisting.push('README.md');
    console.log(`  ${SKIP}  exists  ${DIM('README.md (preserved)')}`);
  } else {
    if (!dryRun) await fsAsync.writeFile(readmeAbs, buildReadme(distributionName, isFastapi), 'utf8');
    filesCreated.push('README.md');
    console.log(`  ${PASS}  write   ${DIM('README.md')}`);
  }

  return {
    filesCreated,
    dirsCreated,
    filesSkippedExisting,
    // Node-shape fields — we never touch package.json / tsconfig in Python.
    packageJsonAction: 'skipped-exists',
    tsconfigAction: 'skipped-no-ts',
  };
}
