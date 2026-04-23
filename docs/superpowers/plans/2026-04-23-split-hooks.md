# Split Git Hooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `guardrail hook install` into pre-commit (static rules only, <1s) and pre-push (full LLM review). Add `guardrail run --static-only` flag that skips the review phase.

**Architecture:** Extend `hook.ts` with two hook templates and a status subcommand. Add `skipReview` to `RunInput`. Wire `--static-only` in `index.ts`.

**Tech Stack:** TypeScript ESM, Node 22+, shell scripts, `node:test`, `spawnSync` for git init in tests

---

## File Structure

```
src/
  cli/
    hook.ts        MODIFY — add PRE_COMMIT_TEMPLATE, status, --pre-commit-only / --pre-push-only
    index.ts       MODIFY — wire --static-only to run command
  core/
    pipeline/
      run.ts       MODIFY — add skipReview to RunInput, short-circuit before review phase
tests/
  hook.test.ts     NEW — 5 tests for split install/uninstall/status
```

---

### Task 1: Add `--static-only` / `skipReview` to the run pipeline

**Files:**
- Modify: `src/core/pipeline/run.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Add `skipReview?: boolean` to `RunInput` in `src/core/pipeline/run.ts`**

Find `export interface RunInput` and add the field:
```typescript
export interface RunInput {
  touchedFiles: string[];
  config: GuardrailConfig;
  reviewEngine?: ReviewEngine;
  skipReview?: boolean;  // add this line — skips LLM review phase
}
```

- [ ] **Step 2: Short-circuit the review phase when `skipReview` is set**

In `runGuardrail`, find where `runReviewPhase` is called. Wrap in a condition:
```typescript
let reviewResult: ReviewPhaseResult;
if (input.skipReview) {
  reviewResult = {
    phase: 'review',
    status: 'skip',
    findings: [],
    durationMs: 0,
  };
} else {
  reviewResult = await runReviewPhase({
    touchedFiles: input.touchedFiles,
    engine: engine!,
    config: input.config,
  });
}
```

- [ ] **Step 3: Wire `--static-only` in `src/cli/index.ts`**

In `case 'run':`, extract the flag and pass it through:
```typescript
const staticOnly = args.includes('--static-only');
// ... after existing option parsing, add staticOnly to the runCommand call:
skipReview: staticOnly,
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline/run.ts src/cli/index.ts
git commit -m "feat(hooks): add --static-only flag to skip LLM review phase"
```

---

### Task 2: Extend `hook.ts` with pre-commit template and split install

**Files:**
- Modify: `src/cli/hook.ts`

- [ ] **Step 1: Add constants for hook marker and two templates**

After the existing `HOOK_CONTENT` constant, add:
```typescript
const GUARDRAIL_MARKER = '# guardrail-managed';

const PRE_COMMIT_HOOK = `#!/bin/sh
# guardrail-managed
# guardrail pre-commit hook — runs static rules only on staged files
STAGED=$(git diff --cached --name-only --diff-filter=ACM | tr '\\n' ' ')
if [ -z "$STAGED" ]; then exit 0; fi
npx guardrail run --static-only --files $STAGED
`;

const PRE_PUSH_HOOK = `#!/bin/sh
# guardrail-managed
# guardrail pre-push hook — runs full LLM review before push
UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "HEAD~1")
npx guardrail run --base $UPSTREAM
`;
```

- [ ] **Step 2: Update `runHook` signature to accept new flags**

```typescript
export async function runHook(
  sub: string,
  options: {
    cwd?: string;
    force?: boolean;
    silent?: boolean;
    preCommitOnly?: boolean;
    prePushOnly?: boolean;
  } = {},
): Promise<number>
```

- [ ] **Step 3: Replace the `install` case with split-hook logic**

```typescript
case 'install': {
  const installPreCommit = !options.prePushOnly;
  const installPrePush = !options.preCommitOnly;
  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  if (installPreCommit) {
    const p = path.join(hooksDir, 'pre-commit');
    if (fs.existsSync(p) && !options.force) {
      console.error('[hook] pre-commit hook already exists. Use --force to overwrite.');
      return 1;
    }
    fs.writeFileSync(p, PRE_COMMIT_HOOK, 'utf8');
    fs.chmodSync(p, 0o755);
    console.log(`[hook] installed pre-commit (static-only) at ${p}`);
  }

  if (installPrePush) {
    const p = path.join(hooksDir, 'pre-push');
    if (fs.existsSync(p) && !options.force) {
      console.error('[hook] pre-push hook already exists. Use --force to overwrite.');
      return 1;
    }
    fs.writeFileSync(p, PRE_PUSH_HOOK, 'utf8');
    fs.chmodSync(p, 0o755);
    console.log(`[hook] installed pre-push (full LLM review) at ${p}`);
  }
  return 0;
}
```

- [ ] **Step 4: Replace `uninstall` to remove both managed hooks**

```typescript
case 'uninstall': {
  let removed = false;
  for (const name of ['pre-commit', 'pre-push']) {
    const p = path.join(gitDir, 'hooks', name);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      if (content.includes(GUARDRAIL_MARKER)) {
        fs.rmSync(p);
        console.log(`[hook] removed ${p}`);
        removed = true;
      } else {
        console.log(`[hook] skipping ${p} — not managed by guardrail`);
      }
    }
  }
  if (!removed) console.log('[hook] no guardrail hooks installed');
  return 0;
}
```

- [ ] **Step 5: Replace `status` to report both hooks**

```typescript
case 'status': {
  for (const name of ['pre-commit', 'pre-push']) {
    const p = path.join(gitDir, 'hooks', name);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      const managed = content.includes(GUARDRAIL_MARKER);
      console.log(`[hook] ${name}: installed${managed ? ' (guardrail-managed)' : ' (external)'}`);
    } else {
      console.log(`[hook] ${name}: not installed`);
    }
  }
  return 0;
}
```

- [ ] **Step 6: Wire new flags in `src/cli/index.ts`**

In `case 'hook':`, add:
```typescript
const preCommitOnly = args.includes('--pre-commit-only');
const prePushOnly = args.includes('--pre-push-only');
const code = await runHook(hookSub, { force, preCommitOnly, prePushOnly });
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add src/cli/hook.ts src/cli/index.ts
git commit -m "feat(hooks): split pre-commit (static-only) + pre-push (LLM review) hook templates"
```

---

### Task 3: Tests for split hooks

**Files:**
- Create: `tests/hook.test.ts`

- [ ] **Step 1: Write test file**

```typescript
// tests/hook.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHook } from '../src/cli/hook.ts';

function initRepo(dir: string): void {
  spawnSync('git', ['init', dir], { stdio: 'ignore' });
}

describe('split hooks', () => {
  it('install writes both hooks by default', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
    initRepo(dir);
    await runHook('install', { cwd: dir, force: true });
    assert.ok(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')));
    assert.ok(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-push')));
    fs.rmSync(dir, { recursive: true });
  });

  it('install --pre-commit-only writes only pre-commit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
    initRepo(dir);
    await runHook('install', { cwd: dir, preCommitOnly: true, force: true });
    assert.ok(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')));
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-push')));
    fs.rmSync(dir, { recursive: true });
  });

  it('install --pre-push-only writes only pre-push', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
    initRepo(dir);
    await runHook('install', { cwd: dir, prePushOnly: true, force: true });
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')));
    assert.ok(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-push')));
    fs.rmSync(dir, { recursive: true });
  });

  it('uninstall removes both guardrail-managed hooks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
    initRepo(dir);
    await runHook('install', { cwd: dir, force: true });
    await runHook('uninstall', { cwd: dir });
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')));
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-push')));
    fs.rmSync(dir, { recursive: true });
  });

  it('status reports installed/not-installed for each hook', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
    initRepo(dir);
    await runHook('install', { cwd: dir, preCommitOnly: true, force: true });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(' '));
    await runHook('status', { cwd: dir });
    console.log = orig;
    const out = lines.join('\n');
    assert.ok(out.includes('pre-commit') && out.includes('installed'));
    assert.ok(out.includes('pre-push') && out.includes('not installed'));
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `node scripts/test-runner.mjs`
Expected: all 5 tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/hook.test.ts
git commit -m "test(hooks): 5 tests for split install, uninstall, status"
```

---

### Task 4: Final typecheck + test run

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 2: Full test suite**

Run: `node scripts/test-runner.mjs`
Expected: all tests pass, 0 failures
