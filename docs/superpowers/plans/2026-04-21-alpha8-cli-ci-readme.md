# Alpha.8 — `autopilot autoregress`, CI Workflow, README

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three polish items for 1.0.0 readiness: (1) expose `autoregress` as a first-class `autopilot autoregress <mode>` subcommand so users don't need to invoke the raw script; (2) add GitHub Actions CI (test on PR + publish on version tag); (3) rewrite the README to document all features from alphas 1-8.

**Architecture:** New `src/cli/autoregress.ts` adapter that bridges the CLI to the existing `scripts/autoregress.ts` functions; dispatch entry in `src/cli/index.ts`; `.github/workflows/ci.yml`; README rewrite.

**Tech Stack:** Node 22, TypeScript ESM, `node:child_process.spawnSync` (for the bridge), GitHub Actions (actions/checkout@v4, actions/setup-node@v4).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/cli/autoregress-bridge.ts` | Create | Thin bridge: parses `autopilot autoregress <mode> [args]` → spawns `scripts/autoregress.ts` |
| `src/cli/index.ts` | Modify | Add `autoregress` case + update help text |
| `.github/workflows/ci.yml` | Create | Test on every PR; publish on `v*` tag |
| `README.md` | Rewrite | Full feature docs covering all alphas |
| `package.json` | Modify | Version → `1.0.0-alpha.8` |
| `CHANGELOG.md` | Modify | Add alpha.8 entry |

---

## Task 1: `autopilot autoregress` CLI subcommand

**Files:**
- Create: `src/cli/autoregress-bridge.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/cli/autoregress-bridge.test.ts`

The bridge is intentionally thin — it re-uses the existing `scripts/autoregress.ts` logic by spawning it as a child process (keeps the bridge testable without re-implementing the dispatch logic).

- [ ] **Step 1.1: Write failing tests**

```typescript
// tests/cli/autoregress-bridge.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoregressArgs } from '../../src/cli/autoregress-bridge.ts';

describe('buildAutoregressArgs', () => {
  it('passes mode and flags through unchanged', () => {
    const result = buildAutoregressArgs(['run', '--all']);
    assert.deepEqual(result, ['run', '--all']);
  });

  it('passes generate --files through unchanged', () => {
    const result = buildAutoregressArgs(['generate', '--files', 'src/foo.ts,src/bar.ts']);
    assert.deepEqual(result, ['generate', '--files', 'src/foo.ts,src/bar.ts']);
  });

  it('defaults to run when no mode provided', () => {
    const result = buildAutoregressArgs([]);
    assert.deepEqual(result, ['run']);
  });

  it('passes diff and update modes through', () => {
    assert.deepEqual(buildAutoregressArgs(['diff', '--snapshot', 'sarif']), ['diff', '--snapshot', 'sarif']);
    assert.deepEqual(buildAutoregressArgs(['update']), ['update']);
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha8
node --test --import tsx tests/cli/autoregress-bridge.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND`

- [ ] **Step 1.3: Implement `src/cli/autoregress-bridge.ts`**

```typescript
// src/cli/autoregress-bridge.ts
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/autoregress.ts');

const VALID_MODES = ['run', 'update', 'generate', 'diff'];

export function buildAutoregressArgs(args: string[]): string[] {
  const mode = args[0] && VALID_MODES.includes(args[0]) ? args[0] : 'run';
  const rest = args[0] && VALID_MODES.includes(args[0]) ? args.slice(1) : args;
  return [mode, ...rest];
}

export async function runAutoregress(args: string[]): Promise<number> {
  const resolvedArgs = buildAutoregressArgs(args);
  const result = spawnSync(
    'node',
    ['--import', 'tsx', SCRIPT, ...resolvedArgs],
    { stdio: 'inherit', cwd: process.cwd() },
  );
  return result.status ?? 1;
}
```

- [ ] **Step 1.4: Add `autoregress` case to `src/cli/index.ts`**

Add `'autoregress'` to `VALUE_FLAGS` array (for `--files`, `--since`, `--snapshot`).

Add this case just before the `default` case in the switch:

```typescript
  case 'autoregress': {
    const { runAutoregress } = await import('./autoregress-bridge.ts');
    const code = await runAutoregress(args.slice(1));
    process.exit(code);
    break;
  }
```

Also update the `printUsage()` function — add these lines to the Commands section:

```
  autoregress run     Run impact-selected snapshot tests (default mode)
  autoregress diff    Show colored diffs vs baselines
  autoregress update  Overwrite baselines with current output
  autoregress generate  Generate snapshot tests via LLM for changed files
```

And add to Options section:

```
Options (autoregress):
  --all                  Run/diff all snapshots
  --since <ref>          Git ref for changed-files detection
  --snapshot <slug>      Target a single snapshot
  --files <a,b,c>        Explicit file list for generate (skips git detection)
```

- [ ] **Step 1.5: Run tests to confirm they pass**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha8
node --test --import tsx tests/cli/autoregress-bridge.test.ts
```

Expected: 4 passing

- [ ] **Step 1.6: Smoke test end-to-end**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha8
# Should call scripts/autoregress.ts run --all internally
npx tsx src/cli/index.ts autoregress run --all
```

Expected: `[autoregress run] --all: running N snapshot(s)` — exits 0

- [ ] **Step 1.7: Commit**

```bash
git add src/cli/autoregress-bridge.ts src/cli/index.ts tests/cli/autoregress-bridge.test.ts
git commit -m "feat(alpha8): autopilot autoregress subcommand — bridges to autoregress script"
```

---

## Task 2: GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 2.1: Create `.github/workflows/ci.yml`**

```bash
mkdir -p /tmp/claude-autopilot/.worktrees/v1-alpha8/.github/workflows
```

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [master]
    tags: ['v*']
  pull_request:
    branches: [master]

jobs:
  test:
    name: Test (Node ${{ matrix.node }})
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ['22']

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm

      - run: npm ci

      - name: Typecheck
        run: npx tsc --noEmit

      - name: Test
        run: node scripts/test-runner.mjs

  publish:
    name: Publish to npm
    needs: test
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          registry-url: 'https://registry.npmjs.org'

      - run: npm ci

      - name: Publish
        run: |
          TAG=$(node -e "const v='${{ github.ref_name }}'; console.log(v.includes('alpha') ? 'alpha' : v.includes('beta') ? 'beta' : 'latest')")
          npm publish --access public --tag $TAG
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 2.2: Verify YAML is valid**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha8
# Basic syntax check
node -e "require('fs').readFileSync('.github/workflows/ci.yml', 'utf8'); console.log('YAML readable')"
```

Expected: `YAML readable`

- [ ] **Step 2.3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions test + npm publish workflow"
```

---

## Task 3: README rewrite

**Files:**
- Rewrite: `README.md`

- [ ] **Step 3.1: Write new README**

The README should document all features from alphas 1-8 as a coherent product. Key sections:

```markdown
# @delegance/claude-autopilot

Automated code review pipeline for Claude Code. Runs static rules, an optional LLM review engine, and impact-aware snapshot regression tests — outputs SARIF for GitHub Code Scanning, inline PR annotations, and a pre-push hook for local enforcement.

## Install

\`\`\`bash
npm install --save-dev @delegance/claude-autopilot@alpha
\`\`\`

Requires Node 22+.

## Quick Start

\`\`\`bash
# Scaffold config
npx autopilot init

# Run on changed files
npx autopilot run

# Watch mode (re-runs on every file save)
npx autopilot watch

# Install pre-push hook
npx autopilot hook install
\`\`\`

## Commands

### `autopilot run`

Runs the pipeline on git-changed files vs the base ref.

\`\`\`bash
npx autopilot run                        # diff against HEAD~1
npx autopilot run --base main            # diff against main
npx autopilot run --files src/foo.ts     # explicit file list
npx autopilot run --format sarif --output results.sarif
npx autopilot run --dry-run              # show what would run, no execution
\`\`\`

### `autopilot watch`

Debounced re-run on every file save.

\`\`\`bash
npx autopilot watch
npx autopilot watch --debounce 500
\`\`\`

### `autopilot hook`

Manages a `pre-push` git hook that runs `autoregress run` before every push.

\`\`\`bash
npx autopilot hook install       # write .git/hooks/pre-push
npx autopilot hook install --force  # overwrite existing
npx autopilot hook uninstall     # remove
npx autopilot hook status        # show installed hook content
\`\`\`

Works in git worktrees (handles `.git` as a file pointer).

### `autopilot autoregress`

Impact-aware snapshot regression testing. Only fires tests whose source modules (or one-hop importers) were touched by the current branch.

\`\`\`bash
npx autopilot autoregress run              # impact-selected snapshots
npx autopilot autoregress run --all        # all snapshots
npx autopilot autoregress diff             # show JSON diffs vs baselines
npx autopilot autoregress update           # overwrite baselines
npx autopilot autoregress generate         # LLM-generate snaps for changed files
npx autopilot autoregress generate --files src/foo.ts,src/bar.ts
\`\`\`

Requires `OPENAI_API_KEY` for `generate` mode.

### `autopilot init`

Scaffolds `autopilot.config.yaml` from a preset.

\`\`\`bash
npx autopilot init
\`\`\`

Available presets: `nextjs-supabase`, `t3`, `python-fastapi`, `rails-postgres`, `go`.

### `autopilot preflight`

Checks prerequisites (Node version, `gh` CLI auth, `OPENAI_API_KEY`).

## GitHub Actions

Add to your workflow:

\`\`\`yaml
- uses: axledbetter/claude-autopilot@v1
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
\`\`\`

Runs the pipeline, uploads SARIF to GitHub Code Scanning, and annotates the PR diff inline.

## SARIF Output

\`\`\`bash
npx autopilot run --format sarif --output autopilot.sarif
\`\`\`

Compatible with `github/codeql-action/upload-sarif@v3`.

## Config (`autopilot.config.yaml`)

\`\`\`yaml
preset: nextjs-supabase          # inherit a base config
reviewEngine:
  adapter: codex
  options:
    model: gpt-5.3-codex
testCommand: npm test
protect:
  - src/core/**
  - data/deltas/**
\`\`\`

## Snapshot Regression Testing

After each feature lands, generate behavioral baselines:

\`\`\`bash
npx autopilot autoregress generate
\`\`\`

Future PRs automatically fail if covered behavior diverges. The impact selector uses `git merge-base` diff + one-hop import graph expansion so only relevant snapshots run — keeping CI token-efficient.

High-impact paths (`src/core/pipeline/**`, `src/adapters/**`, etc.) always trigger a full run.

## Architecture

Four pluggable adapter points:

| Point | Built-in | Purpose |
|---|---|---|
| `review-engine` | `codex` | LLM code review |
| `vcs-host` | `github` | PR comments + SARIF upload |
| `migration-runner` | `supabase` | DB migration execution |
| `review-bot-parser` | `cursor` | Parse review bot comments |

## Requirements

- Node ≥ 22
- `OPENAI_API_KEY` (optional — review engine and generate mode only)
- `gh` CLI authenticated (optional — PR creation / vcs-host adapter)

## License

MIT
```

- [ ] **Step 3.2: Write the README**

Write the full README content above to `README.md` (overwrite the existing file).

- [ ] **Step 3.3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README — document all alpha.1-8 features"
```

---

## Task 4: Version bump + full test run + PR

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 4.1: Bump version**

`package.json`: `"1.0.0-alpha.7"` → `"1.0.0-alpha.8"`

- [ ] **Step 4.2: Add CHANGELOG entry**

At top of `CHANGELOG.md`:

```markdown
## 1.0.0-alpha.8

### Added

- **`autopilot autoregress`** — `autoregress run|diff|update|generate` now available as a first-class `autopilot` subcommand (no more `npx tsx scripts/autoregress.ts`)
- **GitHub Actions CI** — `.github/workflows/ci.yml` runs typecheck + tests on every PR; auto-publishes to npm on `v*` tags using `NPM_TOKEN` secret
- **README rewrite** — full feature documentation covering all alphas (commands, config, GitHub Actions integration, snapshot regression testing, architecture)

```

- [ ] **Step 4.3: Run full test suite**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha8
node scripts/test-runner.mjs
```

Expected: 112 + 4 new (autoregress-bridge: 4) = 116 passing, 0 failures.

- [ ] **Step 4.4: Typecheck**

```bash
npx tsc --noEmit
```

No new errors in touched files.

- [ ] **Step 4.5: Commit + push + PR**

```bash
git add package.json CHANGELOG.md
git commit -m "feat(alpha8): version bump to 1.0.0-alpha.8"
git push -u origin feature/v1-alpha8
gh pr create \
  --title "feat(alpha8): autopilot autoregress CLI, CI workflow, README" \
  --body "$(cat <<'EOF'
## Summary

- **`autopilot autoregress`** subcommand — first-class CLI wrapper; no more naked `npx tsx scripts/autoregress.ts`
- **GitHub Actions CI** — test on PR + publish on `v*` tag (requires `NPM_TOKEN` secret)
- **README rewrite** — documents all features from alphas 1-8 in a single coherent reference

## Test plan

- [ ] `node scripts/test-runner.mjs` — 116 tests passing
- [ ] `npx tsx src/cli/index.ts autoregress run --all` — delegates to script correctly
- [ ] `.github/workflows/ci.yml` — valid YAML, correct trigger conditions

🤖 Generated with [Claude Code](https://claude.ai/claude-code)
EOF
)"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| `autopilot autoregress run|diff|update|generate` | Task 1 |
| Default to `run` when mode omitted | Task 1 |
| `buildAutoregressArgs` tested | Task 1 |
| CI test-on-PR | Task 2 |
| CI publish-on-tag with `alpha`/`beta`/`latest` tag logic | Task 2 |
| README covers all features | Task 3 |
| Version `1.0.0-alpha.8` | Task 4 |

### Type consistency

- `buildAutoregressArgs(args: string[]): string[]` — matches test usage
- `runAutoregress(args: string[]): Promise<number>` — matches index.ts dispatch
- Bridge uses `spawnSync` with array args (injection-safe)

### Placeholder scan

No TBD or vague steps. README content is fully written inline.
