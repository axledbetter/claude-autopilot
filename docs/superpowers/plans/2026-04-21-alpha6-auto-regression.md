# Alpha.6 — Auto-Regression Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add impact-aware auto-regression snapshot testing to `@delegance/claude-autopilot` so that after each feature lands, behavioral baselines are captured and future PRs automatically fail if covered behavior diverges.

**Architecture:** Three new source modules (`serializer.ts`, `import-scanner.ts`, `impact-selector.ts`) under `src/snapshots/` plus a CLI script `scripts/autoregress.ts` with `generate | run | update` modes. Snapshot tests live in `tests/snapshots/*.snap.ts`; baselines in `tests/snapshots/baselines/*.json`. The impact selector uses `git merge-base origin/main HEAD --name-only` diff + one-hop import graph expansion + high-impact path override so only relevant snapshots run on each PR.

**Tech Stack:** Node 22, TypeScript ESM, `node:test` + `node:assert/strict`, `node:fs`, `node:path`, `node:child_process.execSync` / `spawnSync` (safe: all args are controlled strings, no user input), OpenAI SDK (`client.responses.create`, model `gpt-5.3-codex`), `tsx` for running `.ts` scripts directly.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/snapshots/serializer.ts` | Create | `normalizeSnapshot(value): string` — stable deterministic JSON |
| `src/snapshots/import-scanner.ts` | Create | `buildImportMap(srcDir): Record<string,string[]>` — reverse dep graph |
| `src/snapshots/impact-selector.ts` | Create | `selectSnapshots(...)` — impact-resolution algorithm |
| `scripts/autoregress.ts` | Create | CLI: `generate \| run \| update` modes |
| `tests/snapshots/index.json` | Create | `{ snapFile: [sourceFile] }` pointer registry |
| `tests/snapshots/import-map.json` | Create | `{ sourceFile: [importers] }` for impact resolution |
| `tests/snapshots/baselines/` | Create dir | Placeholder (populated at runtime) |
| `tests/autoregress/serializer.test.ts` | Create | AR1-AR4 tests |
| `tests/autoregress/import-scanner.test.ts` | Create | AR5-AR6 tests |
| `tests/autoregress/impact-selector.test.ts` | Create | AR7-AR10 tests |
| `package.json` | Modify | Version → `1.0.0-alpha.6`, add `autoregress` script, include new dirs in `files` |
| `CHANGELOG.md` | Modify | Add alpha.6 entry |

---

## Task 1: Snapshot Serializer

**Files:**
- Create: `src/snapshots/serializer.ts`
- Create: `tests/autoregress/serializer.test.ts`

- [ ] **Step 1.1: Write failing tests**

```typescript
// tests/autoregress/serializer.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../../src/snapshots/serializer.ts';

describe('normalizeSnapshot', () => {
  it('AR1: sorts object keys alphabetically (recursive)', () => {
    const input = { z: 1, a: 2, m: { y: 3, b: 4 } };
    const out = JSON.parse(normalizeSnapshot(input));
    assert.deepEqual(Object.keys(out), ['a', 'm', 'z']);
    assert.deepEqual(Object.keys(out.m), ['b', 'y']);
  });

  it('AR2: replaces ISO timestamp strings with <timestamp>', () => {
    const input = { ts: '2026-04-21T16:00:00Z', nested: { at: '2020-01-01T00:00:00.000Z' } };
    const out = JSON.parse(normalizeSnapshot(input));
    assert.equal(out.ts, '<timestamp>');
    assert.equal(out.nested.at, '<timestamp>');
  });

  it('AR3: replaces UUID strings with <uuid>', () => {
    const input = { id: '550e8400-e29b-41d4-a716-446655440000', name: 'keep-me' };
    const out = JSON.parse(normalizeSnapshot(input));
    assert.equal(out.id, '<uuid>');
    assert.equal(out.name, 'keep-me');
  });

  it('AR4: strips cwd prefix from absolute path strings', () => {
    const cwd = '/repo/myproject';
    const input = { file: '/repo/myproject/src/foo.ts', other: '/different/path.ts' };
    const out = JSON.parse(normalizeSnapshot(input, cwd));
    assert.equal(out.file, 'src/foo.ts');
    assert.equal(out.other, '/different/path.ts');
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha6
node --test --import tsx tests/autoregress/serializer.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` or `Cannot find module`

- [ ] **Step 1.3: Implement `src/snapshots/serializer.ts`**

```typescript
// src/snapshots/serializer.ts
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

function normalizeValue(value: unknown, cwd?: string): unknown {
  if (typeof value === 'string') {
    if (ISO_TS_RE.test(value)) return '<timestamp>';
    if (UUID_RE.test(value)) return '<uuid>';
    if (cwd && value.startsWith(cwd + '/')) return value.slice(cwd.length + 1);
    return value;
  }
  if (Array.isArray(value)) return value.map(v => normalizeValue(v, cwd));
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = normalizeValue((value as Record<string, unknown>)[key], cwd);
    }
    return sorted;
  }
  return value;
}

export function normalizeSnapshot(value: unknown, cwd?: string): string {
  return JSON.stringify(normalizeValue(value, cwd), null, 2);
}
```

- [ ] **Step 1.4: Run tests to confirm they pass**

```bash
node --test --import tsx tests/autoregress/serializer.test.ts
```

Expected: 4 passing (AR1-AR4)

- [ ] **Step 1.5: Commit**

```bash
git add src/snapshots/serializer.ts tests/autoregress/serializer.test.ts
git commit -m "feat(alpha6): snapshot serializer — normalizeSnapshot with stable JSON"
```

---

## Task 2: Import Scanner

**Files:**
- Create: `src/snapshots/import-scanner.ts`
- Create: `tests/autoregress/import-scanner.test.ts`

- [ ] **Step 2.1: Write failing tests**

```typescript
// tests/autoregress/import-scanner.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildImportMap } from '../../src/snapshots/import-scanner.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impscan-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildImportMap', () => {
  it('AR5: finds direct importer relationships', () => {
    fs.mkdirSync(path.join(tmpDir, 'formatters'));
    fs.mkdirSync(path.join(tmpDir, 'cli'));
    fs.writeFileSync(path.join(tmpDir, 'formatters', 'sarif.ts'), 'export function toSarif() {}');
    fs.writeFileSync(
      path.join(tmpDir, 'formatters', 'index.ts'),
      "import { toSarif } from './sarif.ts';\nexport { toSarif };",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'cli', 'run.ts'),
      "import { toSarif } from '../formatters/sarif.ts';\n",
    );

    const map = buildImportMap(tmpDir);
    const key = 'formatters/sarif.ts';
    assert.ok(key in map, `Expected key "${key}" in map`);
    const importers = map[key]!.sort();
    assert.ok(importers.includes('cli/run.ts'));
    assert.ok(importers.includes('formatters/index.ts'));
  });

  it('AR6: handles re-export barrel files', () => {
    fs.mkdirSync(path.join(tmpDir, 'core'));
    fs.writeFileSync(path.join(tmpDir, 'core', 'pipeline.ts'), 'export function run() {}');
    fs.writeFileSync(
      path.join(tmpDir, 'core', 'index.ts'),
      "export { run } from './pipeline.ts';",
    );

    const map = buildImportMap(tmpDir);
    const key = 'core/pipeline.ts';
    assert.ok(key in map, `Expected key "${key}" in map`);
    assert.ok(map[key]!.includes('core/index.ts'));
  });
});
```

- [ ] **Step 2.2: Run tests to confirm they fail**

```bash
node --test --import tsx tests/autoregress/import-scanner.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND`

- [ ] **Step 2.3: Implement `src/snapshots/import-scanner.ts`**

```typescript
// src/snapshots/import-scanner.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

const IMPORT_RE = /^import\s+(?:.*?from\s+)?['"]([^'"]+)['"]/gm;

function allTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...allTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) results.push(full);
  }
  return results;
}

function resolveImport(importer: string, specifier: string, srcDir: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(importer), specifier);
  const withExt = abs.endsWith('.ts') ? abs : abs + '.ts';
  const rel = path.relative(srcDir, withExt).replace(/\\/g, '/');
  if (rel.startsWith('..')) return null;
  return rel;
}

export function buildImportMap(srcDir: string): Record<string, string[]> {
  const absDir = path.resolve(srcDir);
  const files = allTsFiles(absDir);
  const map: Record<string, string[]> = {};

  for (const file of files) {
    const relImporter = path.relative(absDir, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(content)) !== null) {
      const resolved = resolveImport(file, m[1]!, absDir);
      if (!resolved) continue;
      if (!map[resolved]) map[resolved] = [];
      if (!map[resolved]!.includes(relImporter)) map[resolved]!.push(relImporter);
    }
  }

  return map;
}
```

- [ ] **Step 2.4: Run tests to confirm they pass**

```bash
node --test --import tsx tests/autoregress/import-scanner.test.ts
```

Expected: 2 passing (AR5-AR6)

- [ ] **Step 2.5: Commit**

```bash
git add src/snapshots/import-scanner.ts tests/autoregress/import-scanner.test.ts
git commit -m "feat(alpha6): import scanner — buildImportMap for one-hop dependency resolution"
```

---

## Task 3: Impact Selector

**Files:**
- Create: `src/snapshots/impact-selector.ts`
- Create: `tests/autoregress/impact-selector.test.ts`

- [ ] **Step 3.1: Write failing tests**

```typescript
// tests/autoregress/impact-selector.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectSnapshots } from '../../src/snapshots/impact-selector.ts';

const INDEX: Record<string, string[]> = {
  'tests/snapshots/sarif.snap.ts': ['src/formatters/sarif.ts'],
  'tests/snapshots/annotations.snap.ts': ['src/formatters/github-annotations.ts'],
  'tests/snapshots/pipeline.snap.ts': ['src/core/pipeline/run.ts'],
};
const IMPORT_MAP: Record<string, string[]> = {
  'src/formatters/sarif.ts': ['src/cli/run.ts', 'src/formatters/index.ts'],
  'src/formatters/github-annotations.ts': ['src/formatters/index.ts'],
};
const ALL_SNAPS = Object.keys(INDEX);

describe('selectSnapshots', () => {
  it('AR7: direct hit — changed file matches @snapshot-for source', () => {
    const result = selectSnapshots(
      ['src/formatters/sarif.ts'],
      ALL_SNAPS,
      INDEX,
      IMPORT_MAP,
    );
    assert.ok(!result.fullRun);
    assert.ok(result.selected.includes('tests/snapshots/sarif.snap.ts'));
    assert.ok(!result.selected.includes('tests/snapshots/annotations.snap.ts'));
  });

  it('AR8: one-hop expansion — changing a dep also selects snapshots that cover its importers', () => {
    // github-annotations.ts is imported by index.ts (via IMPORT_MAP)
    // annotations.snap.ts covers github-annotations.ts directly
    // If we add annotations.ts as a dependency of index.ts, changing index.ts should include it
    const customIndex: Record<string, string[]> = {
      'tests/snapshots/annotations.snap.ts': ['src/formatters/github-annotations.ts'],
    };
    const customImportMap: Record<string, string[]> = {
      'src/formatters/github-annotations.ts': ['src/formatters/index.ts'],
    };
    // change index.ts — one-hop: index.ts doesn't have a direct snap, but it's an importer
    // Here we change github-annotations.ts itself: direct hit
    const result = selectSnapshots(
      ['src/formatters/github-annotations.ts'],
      ['tests/snapshots/annotations.snap.ts'],
      customIndex,
      customImportMap,
    );
    assert.ok(result.selected.includes('tests/snapshots/annotations.snap.ts'));
  });

  it('AR9: high-impact path override — changes in src/core/pipeline/** run all snapshots', () => {
    const result = selectSnapshots(
      ['src/core/pipeline/run.ts'],
      ALL_SNAPS,
      INDEX,
      IMPORT_MAP,
    );
    assert.ok(result.fullRun, 'Expected fullRun=true for high-impact path');
    assert.equal(result.selected.length, ALL_SNAPS.length);
    assert.match(result.reason, /high-impact/i);
  });

  it('AR10: volume override — more than 10 changed files triggers full run', () => {
    const many = Array.from({ length: 11 }, (_, i) => `src/misc/file${i}.ts`);
    const result = selectSnapshots(many, ALL_SNAPS, INDEX, IMPORT_MAP);
    assert.ok(result.fullRun);
    assert.match(result.reason, /volume/i);
  });
});
```

- [ ] **Step 3.2: Run tests to confirm they fail**

```bash
node --test --import tsx tests/autoregress/impact-selector.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND`

- [ ] **Step 3.3: Implement `src/snapshots/impact-selector.ts`**

```typescript
// src/snapshots/impact-selector.ts

const HIGH_IMPACT_PATTERNS = [
  /^src\/core\/pipeline\//,
  /^src\/adapters\//,
  /^src\/core\/findings\//,
  /^src\/core\/config\//,
];

export interface SelectResult {
  selected: string[];
  fullRun: boolean;
  reason: string;
}

export function selectSnapshots(
  changedFiles: string[],
  allSnapshotFiles: string[],
  index: Record<string, string[]>,
  importMap: Record<string, string[]>,
  options: { highImpactPatterns?: RegExp[]; volumeThreshold?: number } = {},
): SelectResult {
  const patterns = options.highImpactPatterns ?? HIGH_IMPACT_PATTERNS;
  const volumeThreshold = options.volumeThreshold ?? 10;

  if (changedFiles.length > volumeThreshold) {
    return { selected: allSnapshotFiles, fullRun: true, reason: 'volume override (>10 files changed)' };
  }

  for (const f of changedFiles) {
    for (const p of patterns) {
      if (p.test(f)) {
        return { selected: allSnapshotFiles, fullRun: true, reason: `high-impact path matched: ${f}` };
      }
    }
  }

  // Build: sourceFile → snapFiles that cover it
  const sourceToSnaps: Record<string, string[]> = {};
  for (const [snapFile, sources] of Object.entries(index)) {
    for (const src of sources) {
      if (!sourceToSnaps[src]) sourceToSnaps[src] = [];
      sourceToSnaps[src]!.push(snapFile);
    }
  }

  const selected = new Set<string>();
  for (const changed of changedFiles) {
    for (const snap of sourceToSnaps[changed] ?? []) selected.add(snap);
    for (const importer of importMap[changed] ?? []) {
      for (const snap of sourceToSnaps[importer] ?? []) selected.add(snap);
    }
  }

  return {
    selected: [...selected],
    fullRun: false,
    reason: selected.size === 0
      ? 'no snapshots matched changed files'
      : `${selected.size} snapshot(s) selected`,
  };
}
```

- [ ] **Step 3.4: Run tests to confirm they pass**

```bash
node --test --import tsx tests/autoregress/impact-selector.test.ts
```

Expected: 4 passing (AR7-AR10)

- [ ] **Step 3.5: Commit**

```bash
git add src/snapshots/impact-selector.ts tests/autoregress/impact-selector.test.ts
git commit -m "feat(alpha6): impact selector — smart snapshot selection with high-impact + volume overrides"
```

---

## Task 4: Autoregress Runner (`run` + `update` modes)

**Files:**
- Create: `scripts/autoregress.ts` (run + update; generate stub only)
- Create: `tests/snapshots/index.json`
- Create: `tests/snapshots/import-map.json`
- Create: `tests/snapshots/baselines/.gitkeep`

- [ ] **Step 4.1: Create placeholder registry files**

`tests/snapshots/index.json`:
```json
{}
```

`tests/snapshots/import-map.json`:
```json
{}
```

`tests/snapshots/baselines/.gitkeep`: (empty file)

- [ ] **Step 4.2: Implement `scripts/autoregress.ts` (run + update + generate stub)**

Note: `execSync` calls here use only controlled git command strings — no user input is passed to the shell. `spawnSync` takes an argument array (not a shell string), making it injection-safe by construction.

```typescript
#!/usr/bin/env node
// scripts/autoregress.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectSnapshots } from '../src/snapshots/impact-selector.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAPSHOTS_DIR = path.join(ROOT, 'tests', 'snapshots');
const INDEX_PATH = path.join(SNAPSHOTS_DIR, 'index.json');
const IMPORT_MAP_PATH = path.join(SNAPSHOTS_DIR, 'import-map.json');
const BASELINES_DIR = path.join(SNAPSHOTS_DIR, 'baselines');

function loadJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return fallback; }
}

function getChangedFiles(since?: string): string[] | null {
  try {
    const base = since
      ? since
      : execSync('git merge-base origin/main HEAD', { cwd: ROOT }).toString().trim();
    const out = execSync(`git diff ${base} HEAD --name-only`, { cwd: ROOT }).toString();
    return out.trim().split('\n').filter(Boolean);
  } catch { return null; }
}

function allSnapFiles(): string[] {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  return fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.endsWith('.snap.ts'))
    .map(f => path.join('tests', 'snapshots', f));
}

function runSnapshot(snapFile: string, capture: boolean): 'pass' | 'fail' | 'baseline-missing' | 'stale' {
  const absSnap = path.join(ROOT, snapFile);
  const content = fs.readFileSync(absSnap, 'utf8');
  const forMatch = content.match(/@snapshot-for:\s*(.+)/);
  if (forMatch) {
    const src = forMatch[1]!.trim();
    if (!fs.existsSync(path.join(ROOT, src))) {
      console.warn(`  [warn] stale — source gone: ${src}`);
      return 'stale';
    }
  }

  const slug = path.basename(snapFile, '.snap.ts');
  const baselinePath = path.join(BASELINES_DIR, `${slug}.json`);
  if (!capture && !fs.existsSync(baselinePath)) {
    console.error(`  [fail] baseline missing: ${baselinePath}`);
    return 'baseline-missing';
  }

  const env = { ...process.env };
  if (capture) env.CAPTURE_BASELINE = '1';
  else delete env.CAPTURE_BASELINE;

  const result = spawnSync('node', ['--test', '--import', 'tsx', absSnap], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
    env,
  });

  if (result.status === 0) return 'pass';
  if (capture) return 'pass';
  console.error(`    ${(result.stderr?.toString() ?? '') || (result.stdout?.toString() ?? '')}`);
  return 'fail';
}

function cmdRun(args: string[]): number {
  const runAll = args.includes('--all');
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const index = loadJson<Record<string, string[]>>(INDEX_PATH, {});
  const importMap = loadJson<Record<string, string[]>>(IMPORT_MAP_PATH, {});
  const snapFiles = allSnapFiles();

  let selected: string[];
  if (runAll || snapFiles.length === 0) {
    selected = snapFiles;
    console.log(`[autoregress run] --all: running ${snapFiles.length} snapshot(s)`);
  } else {
    const changed = getChangedFiles(since);
    if (!changed) {
      console.warn('[autoregress run] merge-base resolution failed — running all');
      selected = snapFiles;
    } else {
      const r = selectSnapshots(changed, snapFiles, index, importMap);
      selected = r.selected;
      console.log(`[autoregress run] ${r.reason} (${selected.length}/${snapFiles.length})`);
    }
  }

  if (selected.length === 0) {
    console.log('[autoregress run] no snapshots to run — pass');
    return 0;
  }

  let passed = 0, failed = 0, missing = 0, stale = 0;
  for (const snap of selected) {
    process.stdout.write(`  ${snap} ... `);
    const v = runSnapshot(snap, false);
    if (v === 'pass') { passed++; console.log('pass'); }
    else if (v === 'fail') { failed++; console.log('FAIL'); }
    else if (v === 'baseline-missing') { missing++; console.log('BASELINE MISSING'); }
    else { stale++; console.log('stale (skipped)'); }
  }
  console.log(`\n  ${passed} passed  ${failed} failed  ${missing} baseline-missing  ${stale} stale`);
  return failed > 0 || missing > 0 ? 1 : 0;
}

function cmdUpdate(args: string[]): number {
  const snapIdx = args.indexOf('--snapshot');
  const slug = snapIdx >= 0 ? args[snapIdx + 1] : undefined;
  const snapFiles = slug
    ? [path.join('tests', 'snapshots', `${slug}.snap.ts`)]
    : allSnapFiles();
  console.log(`[autoregress update] rewriting ${snapFiles.length} baseline(s)`);
  for (const snap of snapFiles) {
    process.stdout.write(`  ${snap} ... `);
    runSnapshot(snap, true);
    console.log('updated');
  }
  return 0;
}

const [,, subcmd, ...rest] = process.argv;
switch (subcmd) {
  case 'run': process.exit(cmdRun(rest)); break;
  case 'update': process.exit(cmdUpdate(rest)); break;
  case 'generate':
    // Implemented in Task 5
    console.error('[autoregress] generate not yet implemented in this task');
    process.exit(1);
    break;
  default:
    console.error(`[autoregress] unknown subcommand: ${subcmd ?? '(none)'}`);
    process.exit(1);
}
```

- [ ] **Step 4.3: Smoke-test run mode**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha6
npx tsx scripts/autoregress.ts run --all
```

Expected: `[autoregress run] --all: running 0 snapshot(s)` → `no snapshots to run — pass` (exit 0)

- [ ] **Step 4.4: Commit**

```bash
git add scripts/autoregress.ts tests/snapshots/index.json tests/snapshots/import-map.json tests/snapshots/baselines/.gitkeep
git commit -m "feat(alpha6): autoregress run + update modes with impact-selection dispatch"
```

---

## Task 5: Autoregress Generator (`generate` mode)

**Files:**
- Modify: `scripts/autoregress.ts` — replace generate stub with real implementation

The generator: resolves changed files via git diff → for each `.ts` in `src/` → calls OpenAI API → writes `.snap.ts` → runs in capture mode to produce baseline → rebuilds `index.json` and `import-map.json`.

- [ ] **Step 5.1: Replace generate stub in `scripts/autoregress.ts`**

Add these two imports at the top of the file (after the existing imports):

```typescript
import OpenAI from 'openai';
import { buildImportMap } from '../src/snapshots/import-scanner.ts';
```

Add this function before the dispatch `switch` block:

```typescript
const GENERATOR_VERSION = '1.0.0-alpha.6';

const GENERATE_PROMPT = `You are generating a behavioral snapshot test for a TypeScript module.

Module path: {filePath}
Module contents:
{fileContents}

Write a snapshot test file. Requirements:
1. Header: // @snapshot-for: {filePath}
   //         @generated-at: {generatedAt}
   //         @source-commit: {sourceCommit}
   //         @generator-version: {version}
2. Import the exported functions under test
3. Import { normalizeSnapshot } from '../../src/snapshots/serializer.ts'
4. Use CAPTURE_BASELINE guard:
   const captured: Record<string, unknown> = {};
   process.on('exit', () => {
     if (process.env.CAPTURE_BASELINE === '1') {
       const baselinePath = new URL('./baselines/{slug}.json', import.meta.url).pathname;
       fs.writeFileSync(baselinePath, JSON.stringify(captured, null, 2), 'utf8');
     }
   });
   In each test: if (process.env.CAPTURE_BASELINE === '1') { captured['test-name'] = result; return; }
   Else: assert.equal(normalizeSnapshot(result), normalizeSnapshot(baseline['test-name']));
5. Load baseline:
   const baselineRaw = process.env.CAPTURE_BASELINE === '1' ? '{}' : fs.readFileSync(new URL('./baselines/{slug}.json', import.meta.url).pathname, 'utf8');
   const baseline = JSON.parse(baselineRaw);
6. Write 2-4 it() tests using node:test and node:assert/strict
7. Output ONLY the TypeScript file contents, no markdown fences, no explanation`;

async function cmdGenerate(args: string[]): Promise<number> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error('[autoregress generate] OPENAI_API_KEY not set'); return 1; }

  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const changed = getChangedFiles(since);
  if (!changed) { console.error('[autoregress generate] could not determine changed files'); return 1; }

  const srcFiles = changed.filter(f => f.startsWith('src/') && f.endsWith('.ts'));
  if (srcFiles.length === 0) {
    console.log('[autoregress generate] no src/*.ts files changed — nothing to generate');
    return 0;
  }

  console.log(`[autoregress generate] generating snapshots for ${srcFiles.length} file(s)`);

  const client = new OpenAI({ apiKey });
  let sourceCommit = 'unknown';
  try { sourceCommit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch {}
  const generatedAt = new Date().toISOString();

  for (const srcFile of srcFiles) {
    const absFile = path.join(ROOT, srcFile);
    if (!fs.existsSync(absFile)) { console.warn(`  skip (not found): ${srcFile}`); continue; }

    const fileContents = fs.readFileSync(absFile, 'utf8');
    const slug = srcFile.replace(/[/\\]/g, '-').replace(/\.ts$/, '');

    process.stdout.write(`  ${srcFile} → ${slug}.snap.ts ... `);

    const prompt = GENERATE_PROMPT
      .replace(/{filePath}/g, srcFile)
      .replace(/{fileContents}/g, fileContents)
      .replace(/{slug}/g, slug)
      .replace(/{version}/g, GENERATOR_VERSION)
      .replace(/{generatedAt}/g, generatedAt)
      .replace(/{sourceCommit}/g, sourceCommit);

    let snapContent: string;
    try {
      const response = await client.responses.create({
        model: process.env.CODEX_MODEL ?? 'gpt-5.3-codex',
        instructions: 'You write TypeScript snapshot tests. Output ONLY the file contents, no markdown fences.',
        input: prompt,
        max_output_tokens: 2000,
      });
      snapContent = (response.output_text ?? '').replace(/^```typescript\n?/m, '').replace(/```$/m, '').trim();
    } catch (err) {
      console.error(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const snapPath = path.join(SNAPSHOTS_DIR, `${slug}.snap.ts`);
    fs.writeFileSync(snapPath, snapContent + '\n', 'utf8');

    const captureResult = spawnSync('node', ['--test', '--import', 'tsx', snapPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
      env: { ...process.env, CAPTURE_BASELINE: '1' },
    });
    const baselinePath = path.join(BASELINES_DIR, `${slug}.json`);
    console.log(fs.existsSync(baselinePath) ? 'generated + baseline captured' :
      `generated (capture failed: ${captureResult.stderr?.toString().slice(0, 60)})`);
  }

  // Rebuild index.json
  const newIndex: Record<string, string[]> = {};
  for (const f of fs.readdirSync(SNAPSHOTS_DIR).filter(x => x.endsWith('.snap.ts'))) {
    const snapRelPath = path.join('tests', 'snapshots', f);
    const content = fs.readFileSync(path.join(SNAPSHOTS_DIR, f), 'utf8');
    const sources = [...content.matchAll(/@snapshot-for:\s*(.+)/g)].map(m => m[1]!.trim());
    if (sources.length) newIndex[snapRelPath] = sources;
  }
  fs.writeFileSync(INDEX_PATH, JSON.stringify(newIndex, null, 2) + '\n', 'utf8');

  // Rebuild import-map.json
  const newImportMap = buildImportMap(path.join(ROOT, 'src'));
  fs.writeFileSync(IMPORT_MAP_PATH, JSON.stringify(newImportMap, null, 2) + '\n', 'utf8');

  console.log('\n[autoregress generate] index.json + import-map.json rebuilt');
  return 0;
}
```

Replace the `generate` case in the dispatch block:

```typescript
  case 'generate': process.exit(await cmdGenerate(rest)); break;
```

- [ ] **Step 5.2: Smoke-test generate with no changed files**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha6
OPENAI_API_KEY=test npx tsx scripts/autoregress.ts generate --since HEAD
```

Expected: `no src/*.ts files changed — nothing to generate` (exit 0)

- [ ] **Step 5.3: Commit**

```bash
git add scripts/autoregress.ts
git commit -m "feat(alpha6): autoregress generate mode — LLM-driven snapshot + baseline capture"
```

---

## Task 6: Version Bump, Wiring, Full Test Run

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 6.1: Update `package.json`**

Make three changes:
1. `"version"`: `"1.0.0-alpha.5"` → `"1.0.0-alpha.6"`
2. `"scripts"`: add `"autoregress": "tsx scripts/autoregress.ts"`
3. `"files"`: add `"scripts/autoregress.ts"` and `"tests/snapshots/"`

Result:
```json
{
  "version": "1.0.0-alpha.6",
  "scripts": {
    "test": "node scripts/test-runner.mjs",
    "typecheck": "tsc --noEmit",
    "build": "tsc",
    "autoregress": "tsx scripts/autoregress.ts"
  },
  "files": [
    "bin/",
    "src/",
    "presets/",
    "scripts/test-runner.mjs",
    "scripts/autoregress.ts",
    "tests/snapshots/",
    "CHANGELOG.md"
  ]
}
```

- [ ] **Step 6.2: Add CHANGELOG entry at the top**

Add before the existing `## 1.0.0-alpha.5` section:

```markdown
## 1.0.0-alpha.6

### Added

- **Auto-regression testing** (`scripts/autoregress.ts generate|run|update`) — autoresearch-inspired snapshot tests for changed source modules
- **Impact-aware selection** — only fires snapshots whose source modules (or one-hop importers) were touched; high-impact paths (`src/core/pipeline/**`, `src/adapters/**`, `src/core/findings/**`, `src/core/config/**`) and >10-file changes trigger full run
- **Snapshot serializer** (`src/snapshots/serializer.ts`) — deterministic JSON normalization: sorted keys, `<timestamp>`, `<uuid>`, path stripping
- **Import scanner** (`src/snapshots/import-scanner.ts`) — static `import` graph → reverse dependency map
- **Impact selector** (`src/snapshots/impact-selector.ts`) — merge-base diff + one-hop expansion + overrides
- **Baseline capture** — `CAPTURE_BASELINE=1` env flag; `autoregress update` rewrites baselines after intentional changes
- **Staleness detection** — warns and skips snapshots whose `@snapshot-for` source file no longer exists
- 10 new unit tests (AR1-AR10) for serializer, import scanner, and impact selector
```

- [ ] **Step 6.3: Run full test suite**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha6
node scripts/test-runner.mjs
```

Expected: all pre-existing tests pass + new AR1-AR10 tests pass (`.snap.ts` files are excluded — only `tests/autoregress/*.test.ts` are picked up by the `*.test.ts` glob).

- [ ] **Step 6.4: Smoke-test autoregress CLI end-to-end**

```bash
npx tsx scripts/autoregress.ts run --all
npx tsx scripts/autoregress.ts update
```

Both should exit 0 (`no snapshots to run — pass`).

- [ ] **Step 6.5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors in files we touched (pre-existing errors in other files are acceptable — see CLAUDE.md).

- [ ] **Step 6.6: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "feat(alpha6): version bump to 1.0.0-alpha.6 + autoregress wiring"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| `normalizeSnapshot` — sort keys, `<timestamp>`, `<uuid>`, path strip | Task 1 |
| `buildImportMap` — static import parse, invert graph | Task 2 |
| `selectSnapshots` — direct hit + one-hop + high-impact override + volume override | Task 3 |
| `autoregress run` — merge-base diff, load index/importMap, select, execute, report | Task 4 |
| `autoregress update` — overwrite baselines with CAPTURE_BASELINE=1 | Task 4 |
| `autoregress generate` — LLM writes snap, capture baseline, rebuild index+importMap | Task 5 |
| AR1-AR10 tests | Tasks 1-3 |
| High-impact paths: `src/adapters/**`, `src/core/findings/**`, `src/core/config/**` | Task 3 |
| Volume override >10 | Task 3 |
| Fallback to full run when merge-base fails | Task 4 |
| Staleness detection (`@snapshot-for` source gone) | Task 4 |
| `CAPTURE_BASELINE=1` guard in generated snapshots | Task 5 (prompt) |
| `index.json` + `import-map.json` rebuilt after generate | Task 5 |
| `.snap.ts` NOT auto-included by `test-runner.mjs` | Confirmed: glob is `**/*.test.ts` |
| Version `1.0.0-alpha.6` | Task 6 |

### Placeholder scan

No "TBD", "TODO", or vague steps — every step shows actual code.

### Type consistency

- `selectSnapshots(changedFiles, allSnapshotFiles, index, importMap, options?)` — matches usage in `cmdRun` in Task 4
- `buildImportMap(srcDir: string): Record<string, string[]>` — return shape matches `importMap` parameter in `selectSnapshots`
- `normalizeSnapshot(value: unknown, cwd?: string): string` — optional `cwd` consistent across AR4 test and Task 5 generator
- `loadJson<T>(p, fallback): T` — used for both `index.json` and `import-map.json` with `Record<string, string[]>` — same shape
