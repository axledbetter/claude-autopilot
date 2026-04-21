# Alpha.7 — Hook Installer, Snapshot Viewer, Real Baselines

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three additions that complete the alpha.6 auto-regression loop: (1) `autopilot hook install` writes a pre-push git hook; (2) `autoregress diff` shows colored JSON diffs vs baselines; (3) `autoregress generate --files` bypasses git detection for explicit file lists, enabling real baseline generation for the alpha.6 snapshot modules.

**Architecture:** New `src/cli/hook.ts` + dispatch in `src/cli/index.ts`; add `cmdDiff` and `--files` support to `scripts/autoregress.ts`; update `GENERATE_PROMPT` to support `AUTOREGRESS_TEMP_BASELINE_DIR` env var for diff capture.

**Tech Stack:** Node 22, TypeScript ESM, `node:fs`, `node:path`, `node:child_process.spawnSync`, `node:os` (mkdtemp), ANSI color codes (no external dep), `node:test` + `node:assert/strict`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/cli/hook.ts` | Create | `runHook(sub, opts)` — install/uninstall/status |
| `src/cli/index.ts` | Modify | Add `hook` subcommand dispatch |
| `scripts/autoregress.ts` | Modify | Add `cmdDiff`, `--files` to `cmdGenerate`, update `GENERATE_PROMPT` |
| `tests/cli/hook.test.ts` | Create | 4 tests for install/force/uninstall/status |
| `tests/autoregress/diff.test.ts` | Create | 3 tests for diff mode |
| `package.json` | Modify | Version → `1.0.0-alpha.7` |
| `CHANGELOG.md` | Modify | Add alpha.7 entry |

---

## Task 1: `autopilot hook install/uninstall/status`

**Files:**
- Create: `src/cli/hook.ts`
- Create: `tests/cli/hook.test.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1.1: Write failing tests**

```typescript
// tests/cli/hook.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runHook } from '../../src/cli/hook.ts';

let tmpDir: string;
let gitDir: string;
let hooksDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  gitDir = path.join(tmpDir, '.git');
  hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('autopilot hook', () => {
  it('install: writes pre-push hook and makes it executable', async () => {
    const code = await runHook('install', { cwd: tmpDir });
    assert.equal(code, 0);
    const hookPath = path.join(hooksDir, 'pre-push');
    assert.ok(fs.existsSync(hookPath), 'hook file should exist');
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(content.includes('autoregress'), 'hook should reference autoregress');
    const mode = fs.statSync(hookPath).mode;
    assert.ok((mode & 0o111) !== 0, 'hook should be executable');
  });

  it('install: exits 1 if hook already exists (no --force)', async () => {
    const hookPath = path.join(hooksDir, 'pre-push');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho existing\n', 'utf8');
    const code = await runHook('install', { cwd: tmpDir });
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(hookPath, 'utf8'), '#!/bin/sh\necho existing\n');
  });

  it('install --force: overwrites existing hook', async () => {
    const hookPath = path.join(hooksDir, 'pre-push');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho existing\n', 'utf8');
    const code = await runHook('install', { cwd: tmpDir, force: true });
    assert.equal(code, 0);
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(content.includes('autoregress'));
  });

  it('uninstall: removes hook file', async () => {
    const hookPath = path.join(hooksDir, 'pre-push');
    fs.writeFileSync(hookPath, '#!/bin/sh\n# autopilot pre-push hook\n', 'utf8');
    const code = await runHook('uninstall', { cwd: tmpDir });
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(hookPath), 'hook file should be removed');
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha7
node --test --import tsx tests/cli/hook.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND`

- [ ] **Step 1.3: Implement `src/cli/hook.ts`**

```typescript
// src/cli/hook.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

const HOOK_CONTENT = `#!/bin/sh
# autopilot pre-push hook — runs impact-selected snapshots before push
npx tsx scripts/autoregress.ts run
`;

function findGitDir(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.git');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export async function runHook(
  sub: string,
  options: { cwd?: string; force?: boolean } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const gitDir = findGitDir(cwd);

  if (!gitDir) {
    console.error('[hook] not inside a git repository');
    return 1;
  }

  const hookPath = path.join(gitDir, 'hooks', 'pre-push');

  switch (sub) {
    case 'install': {
      if (fs.existsSync(hookPath) && !options.force) {
        console.error(`[hook] pre-push hook already exists at ${hookPath}`);
        console.error('       Use --force to overwrite.');
        return 1;
      }
      fs.mkdirSync(path.dirname(hookPath), { recursive: true });
      fs.writeFileSync(hookPath, HOOK_CONTENT, 'utf8');
      fs.chmodSync(hookPath, 0o755);
      console.log(`[hook] installed pre-push hook at ${hookPath}`);
      return 0;
    }
    case 'uninstall': {
      if (!fs.existsSync(hookPath)) {
        console.log('[hook] no pre-push hook installed');
        return 0;
      }
      fs.rmSync(hookPath);
      console.log(`[hook] removed ${hookPath}`);
      return 0;
    }
    case 'status': {
      if (fs.existsSync(hookPath)) {
        console.log(`[hook] installed at ${hookPath}`);
        console.log(fs.readFileSync(hookPath, 'utf8'));
      } else {
        console.log('[hook] not installed');
      }
      return 0;
    }
    default:
      console.error(`[hook] unknown subcommand: ${sub}`);
      console.error('Usage: autopilot hook <install|uninstall|status> [--force]');
      return 1;
  }
}
```

- [ ] **Step 1.4: Add `hook` dispatch to `src/cli/index.ts`**

Add `'hook'` to the `SUBCOMMANDS` array and add a case before the `default` case:

```typescript
  case 'hook': {
    const { runHook } = await import('./hook.ts');
    const hookSub = args[1] ?? 'status';
    const force = boolFlag('force');
    const code = await runHook(hookSub, { force });
    process.exit(code);
    break;
  }
```

Also add `import` for the hook module at the top of the imports (or keep as dynamic import in the case block — dynamic is fine to avoid loading it when not needed).

- [ ] **Step 1.5: Run tests to confirm they pass**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha7
node --test --import tsx tests/cli/hook.test.ts
```

Expected: 4 passing

- [ ] **Step 1.6: Smoke test CLI**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha7
# Create a fake .git/hooks dir to test against
mkdir -p /tmp/hook-smoke/.git/hooks
cd /tmp/hook-smoke
npx tsx /tmp/claude-autopilot/.worktrees/v1-alpha7/src/cli/index.ts hook status
npx tsx /tmp/claude-autopilot/.worktrees/v1-alpha7/src/cli/index.ts hook install
npx tsx /tmp/claude-autopilot/.worktrees/v1-alpha7/src/cli/index.ts hook status
```

Expected: status shows "not installed", then "installed", then shows content.

- [ ] **Step 1.7: Commit**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha7
git add src/cli/hook.ts src/cli/index.ts tests/cli/hook.test.ts
git commit -m "feat(alpha7): autopilot hook install/uninstall/status"
```

---

## Task 2: `autoregress diff` — snapshot viewer

**Files:**
- Modify: `scripts/autoregress.ts` — add `cmdDiff` function + `AUTOREGRESS_TEMP_BASELINE_DIR` support in `GENERATE_PROMPT`

- [ ] **Step 2.1: Write failing tests**

```typescript
// tests/autoregress/diff.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { diffBaselines } from '../../scripts/autoregress.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('diffBaselines', () => {
  it('returns empty array when baseline and current match', () => {
    const baseline = { a: 1, b: 'hello' };
    const current = { a: 1, b: 'hello' };
    const lines = diffBaselines(JSON.stringify(baseline, null, 2), JSON.stringify(current, null, 2));
    assert.equal(lines.length, 0);
  });

  it('returns diff lines when values differ', () => {
    const baseline = { a: 1, b: 'old' };
    const current = { a: 1, b: 'new' };
    const lines = diffBaselines(JSON.stringify(baseline, null, 2), JSON.stringify(current, null, 2));
    assert.ok(lines.length > 0);
    const hasRemoved = lines.some(l => l.includes('old'));
    const hasAdded = lines.some(l => l.includes('new'));
    assert.ok(hasRemoved, 'should show removed line with old value');
    assert.ok(hasAdded, 'should show added line with new value');
  });

  it('returns diff lines when keys are added', () => {
    const baseline = { a: 1 };
    const current = { a: 1, b: 2 };
    const lines = diffBaselines(JSON.stringify(baseline, null, 2), JSON.stringify(current, null, 2));
    assert.ok(lines.length > 0);
    assert.ok(lines.some(l => l.includes('"b"')));
  });
});
```

Note: `diffBaselines` is a pure utility function exported from `autoregress.ts` — it takes two JSON strings and returns an array of diff line strings (with `+`/`-` prefixes, no ANSI yet — callers add color).

- [ ] **Step 2.2: Run tests to confirm they fail**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha7
node --test --import tsx tests/autoregress/diff.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` or export not found

- [ ] **Step 2.3: Add `diffBaselines` export and `cmdDiff` to `scripts/autoregress.ts`**

**Add `diffBaselines` export** (pure function, add near the top helpers):

```typescript
export function diffBaselines(baselineJson: string, currentJson: string): string[] {
  if (baselineJson === currentJson) return [];
  const baselineLines = baselineJson.split('\n');
  const currentLines = currentJson.split('\n');
  const lines: string[] = [];
  const maxLen = Math.max(baselineLines.length, currentLines.length);
  for (let i = 0; i < maxLen; i++) {
    const bLine = baselineLines[i];
    const cLine = currentLines[i];
    if (bLine === cLine) continue;
    if (bLine !== undefined) lines.push(`- ${bLine}`);
    if (cLine !== undefined) lines.push(`+ ${cLine}`);
  }
  return lines;
}
```

**Add `cmdDiff` function** before the dispatch switch:

```typescript
function cmdDiff(args: string[]): number {
  const runAll = args.includes('--all');
  const snapIdx = args.indexOf('--snapshot');
  const slug = snapIdx >= 0 ? args[snapIdx + 1] : undefined;
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;

  const index = loadJson<Record<string, string[]>>(INDEX_PATH, {});
  const importMap = loadJson<Record<string, string[]>>(IMPORT_MAP_PATH, {});
  const snapFiles = slug
    ? [path.join('tests', 'snapshots', `${slug}.snap.ts`)]
    : allSnapFiles();

  let selected: string[];
  if (runAll || slug || snapFiles.length === 0) {
    selected = snapFiles;
  } else {
    const changed = getChangedFiles(since);
    if (!changed) {
      selected = snapFiles;
    } else {
      selected = selectSnapshots(changed, snapFiles, index, importMap).selected;
    }
  }

  if (selected.length === 0) {
    console.log('[autoregress diff] no snapshots to diff');
    return 0;
  }

  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const red = useColor ? '\x1b[31m' : '';
  const green = useColor ? '\x1b[32m' : '';
  const reset = useColor ? '\x1b[0m' : '';

  let changed_ = 0;
  for (const snap of selected) {
    const slug_ = path.basename(snap, '.snap.ts');
    const baselinePath = path.join(BASELINES_DIR, `${slug_}.json`);

    if (!fs.existsSync(baselinePath)) {
      console.log(`  ${snap} — ${red}no baseline${reset}`);
      continue;
    }

    // Capture current output to a temp dir
    const tmpBaselinesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-diff-'));
    const tmpBaselinePath = path.join(tmpBaselinesDir, `${slug_}.json`);
    // Copy existing baseline so snapshot doesn't error on read
    fs.copyFileSync(baselinePath, tmpBaselinePath);

    const absSnap = path.join(ROOT, snap);
    spawnSync('node', ['--test', '--import', 'tsx', absSnap], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
      env: { ...process.env, CAPTURE_BASELINE: '1', AUTOREGRESS_TEMP_BASELINE_DIR: tmpBaselinesDir },
    });

    const baselineJson = fs.readFileSync(baselinePath, 'utf8');
    const currentJson = fs.existsSync(tmpBaselinePath) ? fs.readFileSync(tmpBaselinePath, 'utf8') : null;
    fs.rmSync(tmpBaselinesDir, { recursive: true, force: true });

    if (!currentJson) {
      console.log(`  ${snap} — ${red}capture failed${reset}`);
      continue;
    }

    const diffLines = diffBaselines(baselineJson, currentJson);
    if (diffLines.length === 0) {
      console.log(`  ${snap} — \x1b[32m✓ no changes\x1b[0m`);
    } else {
      changed_++;
      console.log(`  ${snap}`);
      for (const line of diffLines) {
        if (line.startsWith('-')) console.log(`    ${red}${line}${reset}`);
        else if (line.startsWith('+')) console.log(`    ${green}${line}${reset}`);
        else console.log(`    ${line}`);
      }
    }
  }

  return changed_ > 0 ? 1 : 0;
}
```

**Add to dispatch switch** (before `default`):
```typescript
  case 'diff': process.exit(cmdDiff(rest)); break;
```

**Add `import * as os from 'node:os'`** at the top of the file (needed for `mkdtempSync`).

**Update GENERATE_PROMPT** to use `AUTOREGRESS_TEMP_BASELINE_DIR` when set. Find the process.on('exit') part in the prompt string and update it:

Replace in GENERATE_PROMPT:
```
       const p = fileURLToPath(new URL('./baselines/{slug}.json', import.meta.url));
       fs.writeFileSync(p, JSON.stringify(captured, null, 2), 'utf8');
```
With:
```
       const p = process.env.AUTOREGRESS_TEMP_BASELINE_DIR
         ? path.join(process.env.AUTOREGRESS_TEMP_BASELINE_DIR, '{slug}.json')
         : fileURLToPath(new URL('./baselines/{slug}.json', import.meta.url));
       fs.writeFileSync(p, JSON.stringify(captured, null, 2), 'utf8');
```

Also add `import * as path from 'node:path';` to the generated file imports in the prompt if not already there.

- [ ] **Step 2.4: Run diff tests to confirm they pass**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha7
node --test --import tsx tests/autoregress/diff.test.ts
```

Expected: 3 passing

- [ ] **Step 2.5: Smoke test diff mode**

```bash
npx tsx scripts/autoregress.ts diff --all
```

Expected: `no snapshots to diff` (exit 0, since no `.snap.ts` files exist yet)

- [ ] **Step 2.6: Commit**

```bash
git add scripts/autoregress.ts tests/autoregress/diff.test.ts
git commit -m "feat(alpha7): autoregress diff — colored snapshot viewer"
```

---

## Task 3: `autoregress generate --files` + real baselines

**Files:**
- Modify: `scripts/autoregress.ts` — add `--files` flag to `cmdGenerate`

- [ ] **Step 3.1: Add `--files` flag to `cmdGenerate`**

In `scripts/autoregress.ts`, inside `cmdGenerate`, find:

```typescript
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const changed = getChangedFiles(since);
  if (!changed) { console.error('[autoregress generate] could not determine changed files'); return 1; }

  const srcFiles = changed.filter(f => f.startsWith('src/') && f.endsWith('.ts'));
  if (srcFiles.length === 0) {
    console.log('[autoregress generate] no src/*.ts files changed — nothing to generate');
    return 0;
  }
```

Replace with:

```typescript
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const filesIdx = args.indexOf('--files');
  const filesArg = filesIdx >= 0 ? args[filesIdx + 1] : undefined;

  let srcFiles: string[];
  if (filesArg) {
    srcFiles = filesArg.split(',').map(f => f.trim()).filter(f => f.startsWith('src/') && f.endsWith('.ts'));
    if (srcFiles.length === 0) {
      console.error('[autoregress generate] --files must contain at least one src/*.ts path');
      return 1;
    }
  } else {
    const changed = getChangedFiles(since);
    if (!changed) { console.error('[autoregress generate] could not determine changed files'); return 1; }
    srcFiles = changed.filter(f => f.startsWith('src/') && f.endsWith('.ts'));
    if (srcFiles.length === 0) {
      console.log('[autoregress generate] no src/*.ts files changed — nothing to generate');
      return 0;
    }
  }
```

- [ ] **Step 3.2: Smoke test `--files` flag**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha7
# Test that --files is parsed correctly (OPENAI_API_KEY not needed for the path that errors out at LLM call)
OPENAI_API_KEY=test npx tsx scripts/autoregress.ts generate --files src/snapshots/serializer.ts 2>&1 | head -5
```

Expected: `[autoregress generate] generating snapshots for 1 file(s)` then an LLM call attempt (may fail with invalid key — that's fine).

- [ ] **Step 3.3: Generate real baselines for alpha.6 modules**

This step requires a real `OPENAI_API_KEY`. Run from the worktree:

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha7
npx tsx scripts/autoregress.ts generate --files \
  src/snapshots/serializer.ts,src/snapshots/import-scanner.ts,src/snapshots/impact-selector.ts,src/formatters/sarif.ts
```

Expected for each file: `generated + baseline captured`

After running, verify:
```bash
ls tests/snapshots/*.snap.ts
ls tests/snapshots/baselines/*.json
cat tests/snapshots/index.json
```

Expected: 4 `.snap.ts` files + 4 baseline `.json` files + `index.json` updated.

If any file shows `generated (capture failed: ...)`:
- Read the generated `.snap.ts` file
- Fix the failing test manually (likely a wrong import path or missing fixture)
- Re-run `autoregress update --snapshot <slug>` to capture the baseline

- [ ] **Step 3.4: Run generated snapshots to confirm they pass**

```bash
npx tsx scripts/autoregress.ts run --all
```

Expected: all 4 snapshots pass (exit 0).

- [ ] **Step 3.5: Commit**

```bash
git add scripts/autoregress.ts tests/snapshots/ 
git commit -m "feat(alpha7): autoregress generate --files + real baselines for alpha.6 modules"
```

---

## Task 4: Version bump + full test run

**Files:**
- Modify: `package.json` — version `1.0.0-alpha.7`
- Modify: `CHANGELOG.md` — add alpha.7 entry

- [ ] **Step 4.1: Bump version**

In `package.json`: `"version": "1.0.0-alpha.6"` → `"version": "1.0.0-alpha.7"`

- [ ] **Step 4.2: Add CHANGELOG entry at top**

```markdown
## 1.0.0-alpha.7

### Added

- **`autopilot hook install`** — writes a `pre-push` git hook that runs `autoregress run` before every push; `hook uninstall` removes it; `hook status` shows current state; `--force` flag overwrites existing hook
- **`autoregress diff`** — colored snapshot viewer showing JSON diffs between current output and baselines; never modifies baselines (use `update` for that)
- **`autoregress generate --files <list>`** — explicit comma-separated file list bypasses git detection; enables generating baselines for any src file on demand
- **Real baselines** — `tests/snapshots/*.snap.ts` + baselines for `serializer.ts`, `import-scanner.ts`, `impact-selector.ts`, and `sarif.ts` — alpha.6 snapshot infrastructure now self-testing
```

- [ ] **Step 4.3: Run full test suite**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha7
node scripts/test-runner.mjs
```

Expected: all pre-existing 105 + 4 new (hook: 4, diff: 3 = 7 new) = 112 passing. `.snap.ts` files excluded by glob.

- [ ] **Step 4.4: Run typecheck**

```bash
npx tsc --noEmit
```

No new errors in files we touched.

- [ ] **Step 4.5: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "feat(alpha7): version bump to 1.0.0-alpha.7"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| `autopilot hook install` writes hook, chmod +x | Task 1 |
| `autopilot hook install` exits 1 if exists, no --force | Task 1 |
| `autopilot hook install --force` overwrites | Task 1 |
| `autopilot hook uninstall` removes | Task 1 |
| `autopilot hook status` reports state | Task 1 |
| `autoregress diff` shows colored diff | Task 2 |
| `autoregress diff` no-op when baselines match | Task 2 |
| `autoregress diff` handles missing baseline | Task 2 |
| `AUTOREGRESS_TEMP_BASELINE_DIR` in generated snaps | Task 2 |
| `autoregress generate --files` explicit list | Task 3 |
| Real baselines for 4 alpha.6 modules | Task 3 |
| Version `1.0.0-alpha.7` | Task 4 |

### Type consistency

- `runHook(sub: string, options: { cwd?: string; force?: boolean }): Promise<number>` — matches test usage
- `diffBaselines(baselineJson: string, currentJson: string): string[]` — matches test usage
- `cmdDiff` uses `os.tmpdir()` — requires `import * as os from 'node:os'` added to autoregress.ts

### Placeholder scan

No TBD or incomplete steps — Task 3 Step 3 notes the "fix manually if capture fails" path explicitly.
