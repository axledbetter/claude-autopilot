# alpha.6 — Auto-Regression Testing (Autoresearch-Inspired)

## Goal

After each feature lands, automatically generate behavioral snapshot tests for affected modules. On future PRs, run only the snapshots whose source modules were touched — keeping CI cheap and token-efficient while still catching regressions.

## Inspiration

Karpathy's autoresearch loop: AI modifies code → evaluates against a metric → keeps improvements, reverts regressions. Here the metric is snapshot match. The agent (LLM) inspects changed code, writes fixtures that capture correct behavior, commits them as baselines. Future PRs fail if behavior diverges.

---

## Architecture

```
scripts/
  autoregress.ts         CLI entry: `generate` | `run` | `update`

tests/snapshots/
  index.json             { "tests/snapshots/sarif.snap.ts": ["src/formatters/sarif.ts"] }
  import-map.json        { "src/formatters/sarif.ts": ["src/cli/run.ts", "src/formatters/index.ts"] }
  baselines/
    sarif.json           normalized RunResult/output baseline
    annotations.json
    ...
  sarif.snap.ts          // @snapshot-for: src/formatters/sarif.ts
  annotations.snap.ts    // @snapshot-for: src/formatters/github-annotations.ts
  ...

src/snapshots/
  serializer.ts          normalizeSnapshot(value) → stable JSON string
  import-scanner.ts      buildImportMap(srcDir) → Record<string, string[]>
```

---

## Impact Resolution

**Git range:** `git diff $(git merge-base origin/main HEAD) HEAD --name-only`

If merge-base resolution fails (shallow clone, detached HEAD, no `origin/main`), fall back to running all snapshots.

**Selection algorithm:**

1. Get changed files from diff
2. Load `tests/snapshots/index.json` → find snapshot files whose `@snapshot-for` source matches a changed file (direct hit)
3. Load `tests/snapshots/import-map.json` → for each changed file, find all files that directly import it (one-hop expansion) → add their snapshot files
4. **High-impact override:** if any changed file matches `src/core/pipeline/**` or `src/adapters/**`, run ALL snapshots
5. **Volume override:** if >10 files changed, run all snapshots
6. **Fallback:** if merge-base fails, run all snapshots

---

## `scripts/autoregress.ts` — Three Modes

### `generate [--since <ref>]`

```
npx tsx scripts/autoregress.ts generate
npx tsx scripts/autoregress.ts generate --since HEAD~3
```

1. Resolve changed files via git diff (same merge-base logic as runner)
2. For each changed source file in `src/`:
   - Read the file
   - Call LLM (via `OPENAI_API_KEY`) with a prompt asking it to write a snapshot test
   - Write `tests/snapshots/<slug>.snap.ts` with `// @snapshot-for: <file>` header
   - Run the snapshot to capture baseline output → write `tests/snapshots/baselines/<slug>.json`
3. Rebuild `tests/snapshots/index.json` from all `@snapshot-for` headers
4. Rebuild `tests/snapshots/import-map.json` via `buildImportMap('src/')`

### `run [--all] [--since <ref>]`

```
npx tsx scripts/autoregress.ts run
npx tsx scripts/autoregress.ts run --all
```

1. Select snapshot files via impact resolution algorithm
2. For each selected snapshot: run it, compare output to baseline
3. Report: pass / fail / baseline-missing
4. Exit 1 if any fail

### `update [--snapshot <slug>]`

```
npx tsx scripts/autoregress.ts update
npx tsx scripts/autoregress.ts update --snapshot sarif
```

Re-runs all (or one) snapshots and overwrites baselines with current output. Use after an intentional behavior change.

---

## `src/snapshots/serializer.ts`

`normalizeSnapshot(value: unknown): string`

Produces stable, deterministic JSON for baseline comparison:
- Sort all object keys alphabetically (recursive)
- Replace ISO timestamp strings matching `/^\d{4}-\d{2}-\d{2}T/` with `"<timestamp>"`
- Replace UUID strings matching `/^[0-9a-f]{8}-[0-9a-f]{4}-/i` with `"<uuid>"`
- Normalize absolute paths to relative (strip cwd prefix)
- Indent 2 spaces

---

## `src/snapshots/import-scanner.ts`

`buildImportMap(srcDir: string): Record<string, string[]>`

Returns: `{ "src/formatters/sarif.ts": ["src/cli/run.ts", "src/formatters/index.ts"] }`

Meaning: "run.ts and index.ts import sarif.ts" — i.e. changing sarif.ts should also trigger run.ts and index.ts snapshots.

Implementation:
- `glob('src/**/*.ts')` recursively
- For each file, parse `import ... from '...'` statements with a regex (no AST parser needed at this scale)
- Resolve relative imports to normalized paths
- Invert the map: from "A imports B" → "B is depended on by A"

Only parses static `import` declarations (not `import()`). Dynamic imports are ignored — their callers are covered by the high-impact override.

---

## Snapshot File Format

```typescript
// @snapshot-for: src/formatters/sarif.ts
// @generated-at: 2026-04-21T16:00:00Z
// @source-commit: abc1234
// @generator-version: 1.0.0-alpha.6

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toSarif } from '../../src/formatters/sarif.ts';
import { normalizeSnapshot } from '../../src/snapshots/serializer.ts';

const BASELINE = JSON.parse(
  fs.readFileSync(
    new URL('./baselines/sarif.json', import.meta.url).pathname,
    'utf8',
  ),
);

describe('snapshot: sarif formatter', () => {
  it('matches baseline for warning finding with line', () => {
    const result = toSarif(
      {
        status: 'warn',
        phases: [],
        allFindings: [{
          id: 'f1', source: 'static-rules', severity: 'warning',
          category: 'no-console', file: 'src/app.ts', line: 10,
          message: 'no console.log', protectedPath: false,
          createdAt: '2026-01-01T00:00:00Z',
        }],
        durationMs: 50,
      },
      { toolVersion: '1.0.0-alpha.6', cwd: '/repo' },
    );
    assert.equal(normalizeSnapshot(result), normalizeSnapshot(BASELINE));
  });
});
```

---

## LLM Generator Prompt (passed to gpt-5.3-codex / claude-sonnet)

```
You are generating a behavioral snapshot test for a TypeScript module.

Module path: {filePath}
Module contents:
{fileContents}

Existing types referenced:
{relevantTypes}

Write a snapshot test file for this module. Requirements:
1. Header comments: // @snapshot-for, @generated-at, @source-commit, @generator-version
2. Import the exported functions under test and `normalizeSnapshot` from `../../src/snapshots/serializer.ts`
3. Load baseline from `../../tests/snapshots/baselines/{slug}.json`
4. Write 2-4 `it()` tests that cover representative behaviors (happy path + one edge case)
5. Each test: call the function with fixed inputs, assert `normalizeSnapshot(result) === normalizeSnapshot(BASELINE[testName])`
6. Use `node:test` and `node:assert/strict`
7. Output ONLY the TypeScript file contents, no explanation

The baseline file will be created by running the generated test with --capture mode.
```

---

## Baseline Capture

After LLM writes the snapshot file, the generator runs it in "capture mode" to produce the baseline:

```typescript
// In generate mode: run the function, write output to baseline
const captured: Record<string, unknown> = {};
// generator substitutes assert calls with capture calls, runs once
fs.writeFileSync(baselinePath, normalizeSnapshot(captured));
```

In practice: the generator writes the test with a special `CAPTURE=true` env guard that writes output instead of asserting, runs it once via `node --test --import tsx`, then rewrites the baseline JSON.

---

## Index + Import Map Rebuild

After generation, both JSON files are fully rebuilt (not incrementally updated):

```typescript
// index.json rebuild
for each .snap.ts file in tests/snapshots/:
  read @snapshot-for header
  index[filePath] = sourceModule

// import-map.json rebuild
importMap = buildImportMap('src/')
write tests/snapshots/import-map.json
```

Both files are committed alongside the generated snapshot tests.

---

## Integration with Existing Test Runner

`scripts/test-runner.mjs` already picks up `tests/**/*.test.ts`. Snapshot files use `.snap.ts` extension — they are NOT auto-included by the glob.

`autoregress run` handles them separately via the impact-selection logic. This keeps the main test suite fast and deterministic.

A `pre-push` hook or CI step runs `autoregress run` after the main test suite.

---

## High-Impact Path Rules

Changes to these paths always trigger all snapshots:

```
src/core/pipeline/**
src/adapters/**
src/core/findings/**
src/core/config/**
```

Rationale: these are cross-cutting — a change here can affect every snapshot.

---

## Staleness Detection

On `autoregress run`, before executing each snapshot:
- Read `@snapshot-for` header
- Check if the source file still exists at that path
- Check if `@generator-version` matches current package version
- If either fails: print a warning, skip the snapshot (don't fail), suggest re-generating

---

## Tests (for the autoregress infrastructure itself)

~10 new tests in `tests/autoregress/`:

| ID | Description |
|---|---|
| AR1 | `normalizeSnapshot` sorts object keys |
| AR2 | `normalizeSnapshot` replaces ISO timestamps |
| AR3 | `normalizeSnapshot` replaces UUIDs |
| AR4 | `normalizeSnapshot` strips cwd from paths |
| AR5 | `buildImportMap` finds direct importer relationships |
| AR6 | `buildImportMap` handles re-export barrel files |
| AR7 | Impact selector: direct hit → correct snapshot selected |
| AR8 | Impact selector: one-hop expansion → importer's snapshot included |
| AR9 | Impact selector: high-impact path → all snapshots selected |
| AR10 | Impact selector: >10 changed files → all snapshots selected |

---

## What Does Not Change

- Existing `tests/**/*.test.ts` test suite — untouched
- `scripts/test-runner.mjs` — no changes (snapshot files use `.snap.ts`, not `.test.ts`)
- All pipeline internals — no changes
