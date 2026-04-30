# v5.4 Vercel Adapter — Phase 4 Implementation Plan (Auto-Rollback)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire post-deploy health check + auto-rollback into `runDeploy()` — when a deploy succeeds but its health check fails 3x AND `rollbackOn: [healthCheckFailure]` is configured, automatically promote the previous prod deploy and surface the rollback in CLI output and (optionally) a PR comment.

**Architecture:** Phase 4 is pure orchestration glue inside `src/cli/deploy.ts`. The adapter contract from Phases 1–3 is unchanged — the Vercel adapter already exposes `rollback()` (Phase 3) and the `DeployResult.rolledBackTo` / `DeployConfig.rollbackOn` / `DeployConfig.healthCheckUrl` types already exist. Phase 4 adds: (a) a small `runHealthCheck()` helper with retries, (b) auto-rollback wiring after `adapter.deploy()` returns `pass`, (c) a `--pr <n>` flag that posts a marker-anchored upserting comment via `gh`, (d) distinct yellow CLI output for the rollback case, and (e) 9 unit tests in `tests/deploy-rollback.test.ts`.

**Tech Stack:** TypeScript (strict), Node 22 built-in `node:test`, native `fetch`, `gh` CLI for PR comments. No new dependencies.

---

## Pre-flight

- [ ] **Step P1: Verify branch and clean state**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
git status -s
git rev-parse --abbrev-ref HEAD
```

Expected: branch is `feature/v5.4-vercel-adapter-phase4`, no staged/unstaged changes outside `.DS_Store`, `.changeset/`, `package-lock.json.stale` (those are pre-existing untracked).

- [ ] **Step P2: Verify baseline tests pass**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
npm test 2>&1 | tail -20
```

Expected: `# pass 904` (or similar count ≥ 904), `# fail 0`. If baseline already broken, STOP and report.

---

## Task 1: Add health-check helper with retries

**Files:**
- Modify: `/Users/alexledbetter/Downloads/claude-autopilot/src/cli/deploy.ts` (add new internal helper near the bottom, before `formatAge`)
- Create: `/Users/alexledbetter/Downloads/claude-autopilot/tests/deploy-rollback.test.ts` (new test file, will grow across tasks)

The health check is a private internal helper, not exported. It accepts an explicit `fetchImpl` parameter so tests can inject a mock — this matches the pattern the Vercel adapter already uses (`fetchImpl: typeof fetch`).

- [ ] **Step 1.1: Write the failing tests for `runHealthCheck`**

Create `tests/deploy-rollback.test.ts` with the first two tests. The helper itself isn't exported yet, so we exercise it through `runDeploy` — but for these initial tests we mock just enough adapter to exercise the success and retry paths.

```typescript
// tests/deploy-rollback.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDeploy } from '../src/cli/deploy.ts';
import type { DeployAdapter } from '../src/adapters/deploy/types.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-deploy-rollback-'));
}

function writeConfig(dir: string, body: string): void {
  fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), body);
}

describe('runDeploy health check', () => {
  it('passes through when health check returns 2xx', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n  healthCheckUrl: https://app.test/healthz\n',
    );
    let healthCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      healthCalls += 1;
      return new Response('ok', { status: 200 });
    };
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() {
        return { status: 'pass', deployId: 'dpl_new', deployUrl: 'https://new.vercel.app', durationMs: 100 };
      },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 0, 'deploy + health-check both pass → exit 0');
      assert.equal(healthCalls, 1, 'health check fired exactly once on first 200');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('retries health check on transient failure then passes', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n  healthCheckUrl: https://app.test/healthz\n',
    );
    let healthCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      healthCalls += 1;
      // 503 the first time, 200 the second time
      return new Response(healthCalls === 1 ? 'down' : 'ok', { status: healthCalls === 1 ? 503 : 200 });
    };
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() { return { status: 'pass', deployId: 'dpl_new', durationMs: 1 }; },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 0, 'transient blip recovered → exit 0');
      assert.equal(healthCalls, 2, '1 fail + 1 pass = 2 calls total');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run:
```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
node --test --import tsx tests/deploy-rollback.test.ts 2>&1 | tail -25
```

Expected: All tests FAIL — `RunDeployOptions` does not currently accept `fetchImpl` or `sleepImpl`, so TypeScript will reject the call (compile-time fail) OR runtime will silently ignore them and exit 0 without any health check happening (which means `healthCalls` stays at 0 and the assertions fail). Either way: confirms we haven't shipped Phase 4 yet.

- [ ] **Step 1.3: Add the `runHealthCheck` helper + wire it into `runDeploy`**

Modify `/Users/alexledbetter/Downloads/claude-autopilot/src/cli/deploy.ts`:

1. **Add to `RunDeployOptions` interface** (after the existing `adapterFactory` field, before the closing `}`):

```typescript
  /**
   * Test seam — injected `fetch` implementation for the post-deploy health
   * check. Defaults to `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test seam — injected sleep function used between health-check retries.
   * Defaults to `setTimeout`-based sleep. Pass `async () => {}` from tests.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /** GitHub PR number — when set, post upserting deploy summary comment. */
  pr?: number;
```

2. **Add the `runHealthCheck` helper at the bottom of the file** (after `formatAge`, before the trailing newline):

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — post-deploy health check + auto-rollback orchestration.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of the post-deploy health check.
 * - `pass`: at least one attempt returned 2xx within the retry budget.
 * - `fail`: all 3 attempts failed (non-2xx, network error, or timeout).
 * - `skipped`: no `healthCheckUrl` resolvable (no config + no deployUrl).
 */
type HealthCheckOutcome = { status: 'pass'; url: string }
                       | { status: 'fail'; url: string; lastError: string }
                       | { status: 'skipped' };

interface HealthCheckOptions {
  url: string;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
}

/**
 * Probe a URL up to 3 times with 2s backoff between attempts. 2xx → pass.
 * Per-attempt timeout is 10s; total wall-clock budget is therefore ≤ 30s
 * (3 × 10s) plus 2 × 2s of backoff. Network errors are treated as failures
 * and retried.
 */
async function runHealthCheck(opts: HealthCheckOptions): Promise<HealthCheckOutcome> {
  const { url, fetchImpl, sleepImpl } = opts;
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status >= 200 && res.status < 300) {
        return { status: 'pass', url };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      clearTimeout(timer);
      lastError = (err as Error)?.message ?? String(err);
    }
    if (attempt < 3) await sleepImpl(2000);
  }
  return { status: 'fail', url, lastError };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

3. **Wire it into `runDeploy`** — replace the block from `result = await deployAdapter.deploy({ ... });` through `printResult(adapter, result);` (lines ~149–170) with:

```typescript
    result = await deployAdapter.deploy({
      ref: opts.ref,
      commitSha: opts.commitSha,
      onDeployStart,
    });

    // Stop the stream now that the deploy is settled. Wait briefly so any
    // in-flight log lines flush before we report.
    streamController?.abort();
    if (streamPromise) {
      try { await streamPromise; } catch { /* already logged */ }
    }

    // Phase 4 — post-deploy health check. Only runs when the deploy itself
    // passed; a build failure already short-circuits to `fail`.
    let healthOutcome: HealthCheckOutcome = { status: 'skipped' };
    if (result.status === 'pass') {
      const healthUrl = merged.healthCheckUrl ?? result.deployUrl;
      if (healthUrl) {
        healthOutcome = await runHealthCheck({
          url: healthUrl,
          fetchImpl: opts.fetchImpl ?? globalThis.fetch,
          sleepImpl: opts.sleepImpl ?? defaultSleep,
        });
      }
    }
  } catch (err) {
    streamController?.abort();
    if (streamPromise) {
      try { await streamPromise; } catch { /* already logged */ }
    }
    console.error(formatErr(`deploy via ${adapter} failed`, err));
    return 1;
  }

  printResult(adapter, result);
  if (result.status === 'pass') return 0;
  if (result.status === 'in-progress') return 2;
  return 1;
}
```

Wait — that places `healthOutcome` inside the `try` but consumes it nowhere yet. Tasks 2 and 3 will use it. For Task 1 we just need the helper present and the success path passing through unchanged. Reformulate:

The actual change in Step 1.3 is narrower: declare `let healthOutcome` in outer scope, populate it inside the try, and **for now** make sure when `healthOutcome.status === 'fail'` we set `result.status = 'fail'` so health-check failures already flip the exit code (auto-rollback wiring lands in Task 2). Replace the block above with this final form:

```typescript
  let result: DeployResult;
  let healthOutcome: HealthCheckOutcome = { status: 'skipped' };
  let streamController: AbortController | undefined;
  let streamPromise: Promise<void> | undefined;
  try {
    const factory = opts.adapterFactory ?? createDeployAdapter;
    const deployAdapter = factory(merged);

    // [existing onDeployStart / streamLogs setup unchanged — keep lines 122–147 as-is]

    result = await deployAdapter.deploy({
      ref: opts.ref,
      commitSha: opts.commitSha,
      onDeployStart,
    });

    streamController?.abort();
    if (streamPromise) {
      try { await streamPromise; } catch { /* already logged */ }
    }

    // Phase 4 — post-deploy health check. Skipped when deploy itself failed.
    if (result.status === 'pass') {
      const healthUrl = merged.healthCheckUrl ?? result.deployUrl;
      if (healthUrl) {
        healthOutcome = await runHealthCheck({
          url: healthUrl,
          fetchImpl: opts.fetchImpl ?? globalThis.fetch,
          sleepImpl: opts.sleepImpl ?? defaultSleep,
        });
        if (healthOutcome.status === 'fail') {
          // Task 2 will wrap this in auto-rollback. For Task 1 we simply
          // demote the result so exit code reflects reality.
          result = {
            ...result,
            status: 'fail',
            output: `Deploy passed but health check failed: ${healthOutcome.lastError} at ${healthOutcome.url}`,
          };
        }
      }
    }
  } catch (err) {
    streamController?.abort();
    if (streamPromise) {
      try { await streamPromise; } catch { /* already logged */ }
    }
    console.error(formatErr(`deploy via ${adapter} failed`, err));
    return 1;
  }

  printResult(adapter, result);
  if (result.status === 'pass') return 0;
  if (result.status === 'in-progress') return 2;
  return 1;
```

(Keep the existing `streamLogs` setup block unmodified — only the post-`deploy()` portion of the try changes.)

- [ ] **Step 1.4: Run the new tests to verify they pass**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
node --test --import tsx tests/deploy-rollback.test.ts 2>&1 | tail -25
```

Expected: 2 pass, 0 fail.

- [ ] **Step 1.5: Run the full test suite to verify no regression**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
npm test 2>&1 | tail -15
```

Expected: all existing tests still green, total count = baseline + 2 new.

- [ ] **Step 1.6: Commit**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
git add src/cli/deploy.ts tests/deploy-rollback.test.ts
git commit -m "feat(deploy): Phase 4 — post-deploy health check with retries"
```

---

## Task 2: Auto-rollback wiring

**Files:**
- Modify: `/Users/alexledbetter/Downloads/claude-autopilot/src/cli/deploy.ts`
- Modify: `/Users/alexledbetter/Downloads/claude-autopilot/tests/deploy-rollback.test.ts`

When health check fails AND `rollbackOn` includes `'healthCheckFailure'` AND adapter has a `rollback` method, invoke it. Surface `rolledBackTo` on the result; mark overall result `fail`. Print a distinct yellow line.

- [ ] **Step 2.1: Write failing tests for the auto-rollback flow**

Append to `tests/deploy-rollback.test.ts`:

```typescript
describe('runDeploy auto-rollback on health-check failure', () => {
  it('positive: rollback fires when rollbackOn includes healthCheckFailure', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: vercel',
        '  project: my-app',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn:',
        '    - healthCheckFailure',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    let rollbackCalls = 0;
    const stdoutLines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { stdoutLines.push(msg); };
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() { return { status: 'pass', deployId: 'dpl_new', deployUrl: 'https://new.vercel.app', durationMs: 1 }; },
      async rollback() {
        rollbackCalls += 1;
        return { status: 'pass', deployId: 'dpl_prev', rolledBackTo: 'dpl_prev', deployUrl: 'https://prev.vercel.app', durationMs: 50 };
      },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1, 'overall deploy result is fail when rollback fires');
      assert.equal(rollbackCalls, 1, 'rollback called exactly once');
      const out = stdoutLines.join('\n');
      assert.match(out, /auto-rolled-back-to=dpl_prev/);
      assert.match(out, /health check failed/i);
    } finally {
      console.log = origLog;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('negative: rollbackOn empty → no rollback attempted', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: vercel',
        '  project: my-app',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn: []',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    let rollbackCalls = 0;
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() { return { status: 'pass', deployId: 'dpl_new', durationMs: 1 }; },
      async rollback() { rollbackCalls += 1; return { status: 'pass', durationMs: 0 }; },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1, 'health-check fail still returns 1');
      assert.equal(rollbackCalls, 0, 'rollback NOT called when rollbackOn empty');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('negative: rollbackOn has only smokeTestFailure → no rollback on healthCheckFailure', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: vercel',
        '  project: my-app',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn:',
        '    - smokeTestFailure',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    let rollbackCalls = 0;
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() { return { status: 'pass', deployId: 'dpl_new', durationMs: 1 }; },
      async rollback() { rollbackCalls += 1; return { status: 'pass', durationMs: 0 }; },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1);
      assert.equal(rollbackCalls, 0, 'smokeTestFailure trigger does not match healthCheckFailure');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('edge: rollback throws (no previous deploy) → exit 1, clear message, no swallow', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: vercel',
        '  project: my-app',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn:',
        '    - healthCheckFailure',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg: string) => { stdoutLines.push(msg); };
    console.error = (msg: string) => { stderrLines.push(msg); };
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() { return { status: 'pass', deployId: 'dpl_new', durationMs: 1 }; },
      async rollback() { throw new Error('no previous production deployment exists'); },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1);
      const allOut = [...stdoutLines, ...stderrLines].join('\n');
      assert.match(allOut, /auto-rollback FAILED|could not find a previous deploy|no previous production deployment/i);
    } finally {
      console.log = origLog;
      console.error = origErr;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('edge: adapter does not support rollback → warning, no crash, exit 1', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: generic',
        '  deployCommand: echo http://x.test',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn:',
        '    - healthCheckFailure',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    const stderrLines: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => { stderrLines.push(msg); };
    const fakeAdapter: DeployAdapter = {
      name: 'generic',
      async deploy() { return { status: 'pass', deployUrl: 'http://x.test', durationMs: 1 }; },
      // No rollback method.
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
      });
      assert.equal(code, 1);
      assert.match(stderrLines.join('\n'), /does not support rollback/);
    } finally {
      console.error = origErr;
      fs.rmSync(dir, { recursive: true });
    }
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
node --test --import tsx tests/deploy-rollback.test.ts 2>&1 | tail -25
```

Expected: 5 new tests fail (rollback never called, no auto-rolled-back output, etc).

- [ ] **Step 2.3: Wire auto-rollback in `runDeploy`**

In `src/cli/deploy.ts`, replace the Task 1 inline block:

```typescript
        if (healthOutcome.status === 'fail') {
          // Task 2 will wrap this in auto-rollback. For Task 1 we simply
          // demote the result so exit code reflects reality.
          result = {
            ...result,
            status: 'fail',
            output: `Deploy passed but health check failed: ${healthOutcome.lastError} at ${healthOutcome.url}`,
          };
        }
```

with the full Phase 4 wiring:

```typescript
        if (healthOutcome.status === 'fail') {
          const triggers = merged.rollbackOn ?? [];
          const wantRollback = triggers.includes('healthCheckFailure');
          if (wantRollback) {
            if (typeof deployAdapter.rollback === 'function') {
              try {
                const rb = await deployAdapter.rollback({});
                if (rb.status === 'pass') {
                  // Note the rollback target on the *deploy* result so the
                  // CLI/PR-comment surfaces stay single-source-of-truth.
                  result = {
                    ...result,
                    status: 'fail',
                    rolledBackTo: rb.rolledBackTo ?? rb.deployId,
                    output: `Deploy passed; health check failed (${healthOutcome.lastError}); auto-rolled back to ${rb.rolledBackTo ?? rb.deployId ?? '<unknown>'}.`,
                  };
                  printAutoRollback(deployAdapter.name, healthOutcome, rb);
                } else {
                  result = {
                    ...result,
                    status: 'fail',
                    output: `Deploy passed; health check failed; auto-rollback ALSO failed: ${rb.output ?? '<no output>'}`,
                  };
                  printAutoRollbackFailed(rb.output ?? 'rollback returned non-pass');
                }
              } catch (err) {
                const msg = (err as Error)?.message ?? String(err);
                result = {
                  ...result,
                  status: 'fail',
                  output: `Deploy passed; health check failed; auto-rollback ERRORED: ${msg}`,
                };
                printAutoRollbackFailed(msg);
              }
            } else {
              console.error(
                `\x1b[33m[deploy] rollbackOn=[healthCheckFailure] configured but adapter "${deployAdapter.name}" does not support rollback\x1b[0m`,
              );
              result = {
                ...result,
                status: 'fail',
                output: `Deploy passed but health check failed: ${healthOutcome.lastError} at ${healthOutcome.url} (adapter does not support rollback)`,
              };
            }
          } else {
            result = {
              ...result,
              status: 'fail',
              output: `Deploy passed but health check failed: ${healthOutcome.lastError} at ${healthOutcome.url}`,
            };
          }
        }
```

Then add the two new printing helpers near `printResult` (after `printResult`, before `formatErr`):

```typescript
function printAutoRollback(adapter: string, hc: { url: string; lastError?: string } & { status: 'fail' }, rb: DeployResult): void {
  const yellow = '\x1b[33m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const target = rb.rolledBackTo ?? rb.deployId ?? '<unknown>';
  console.log(`${yellow}🔄 [deploy] auto-rolled-back-to=${target} via=${adapter} health-check-url=${hc.url}${reset}`);
  console.log(`${dim}   reason: health check failed 3x against ${hc.url} (${hc.lastError ?? 'unknown'})${reset}`);
  if (rb.deployUrl) {
    console.log(`${dim}   current: ${rb.deployUrl}${reset}`);
  }
}

function printAutoRollbackFailed(reason: string): void {
  const yellow = '\x1b[33m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  console.log(`${yellow}🔄 [deploy] auto-rollback FAILED — original deploy left in place${reset}`);
  console.log(`${dim}   reason: ${reason}${reset}`);
}
```

Note the `printAutoRollback` parameter type — `hc` is the failed branch of `HealthCheckOutcome`. Tighten by using a type intersection that matches what we hand it:

Replace the `printAutoRollback` signature with this exact form so TS narrows correctly:

```typescript
function printAutoRollback(
  adapter: string,
  hc: Extract<HealthCheckOutcome, { status: 'fail' }>,
  rb: DeployResult,
): void {
```

And update the call site to pass `healthOutcome` directly (TS will narrow it inside the `if (healthOutcome.status === 'fail')` block):

```typescript
                  printAutoRollback(deployAdapter.name, healthOutcome, rb);
```

- [ ] **Step 2.4: Run the full Phase 4 test file**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
node --test --import tsx tests/deploy-rollback.test.ts 2>&1 | tail -30
```

Expected: all 7 tests pass (2 from Task 1 + 5 from Task 2).

- [ ] **Step 2.5: Run the full test suite for regression**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
npm test 2>&1 | tail -10
```

Expected: total = baseline + 7. No new failures.

- [ ] **Step 2.6: Commit**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
git add src/cli/deploy.ts tests/deploy-rollback.test.ts
git commit -m "feat(deploy): Phase 4 — auto-rollback on health-check failure"
```

---

## Task 3: `--pr <n>` flag + PR comment upsert

**Files:**
- Modify: `/Users/alexledbetter/Downloads/claude-autopilot/src/cli/deploy.ts`
- Modify: `/Users/alexledbetter/Downloads/claude-autopilot/src/cli/index.ts`
- Modify: `/Users/alexledbetter/Downloads/claude-autopilot/tests/deploy-rollback.test.ts`

The PR comment is anchored on a marker distinct from the existing review marker:
- `<!-- guardrail-review -->` — used by validate / pipeline
- `<!-- claude-autopilot-deploy -->` — used by `deploy --pr`

We reuse the `gh` CLI shell pattern from `pr-comment.ts` but build a small inline poster — the existing `formatComment`/`postPrComment` are review-shaped (RunResult input), not deploy-shaped, so a separate function is cleaner than overloading.

- [ ] **Step 3.1: Write failing tests for PR comment posting**

Append to `tests/deploy-rollback.test.ts`:

```typescript
describe('runDeploy --pr comment posting', () => {
  it('with --pr and clean pass: posts a simple "Deploy succeeded" comment', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      'configVersion: 1\ndeploy:\n  adapter: vercel\n  project: my-app\n  healthCheckUrl: https://app.test/healthz\n',
    );
    const fakeFetch: typeof fetch = async () => new Response('ok', { status: 200 });
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() { return { status: 'pass', deployId: 'dpl_new', deployUrl: 'https://new.vercel.app', durationMs: 1 }; },
    };
    const ghCalls: Array<{ args: string[]; bodyContains?: string[] }> = [];
    const fakeGh = (args: string[], opts?: { body?: string }) => {
      ghCalls.push({ args, bodyContains: opts?.body ? [opts.body.slice(0, 200)] : undefined });
      // Simulate "no existing comment" lookup.
      if (args.includes('issues') && args.find((a) => a.includes('comments'))) return '';
      return 'https://github.com/test/repo/pull/42#issuecomment-1';
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
        pr: 42,
        ghImpl: fakeGh,
      });
      assert.equal(code, 0);
      // At minimum: one gh call to post (or upsert) the comment.
      const posted = ghCalls.find((c) => c.args.includes('comment') || c.args.some((a) => a.includes('comments')));
      assert.ok(posted, 'gh was invoked to post a deploy comment');
      // Comment body should contain the marker.
      const bodies = ghCalls.flatMap((c) => c.bodyContains ?? []).join('\n');
      // We allow either the lookup-style (no body yet) or the post-style.
      // What we verify: somewhere in the gh invocations, the body string
      // included the marker. If gh is lookup-only here, the actual post body
      // is on a later call.
      const allArgs = ghCalls.flatMap((c) => c.args).join(' ');
      assert.match(`${bodies}\n${allArgs}`, /claude-autopilot-deploy|Deploy succeeded|✅/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('with --pr and auto-rollback: comment shows both deploy URLs and rollback row', async () => {
    const dir = makeTmp();
    writeConfig(
      dir,
      [
        'configVersion: 1',
        'deploy:',
        '  adapter: vercel',
        '  project: my-app',
        '  healthCheckUrl: https://app.test/healthz',
        '  rollbackOn:',
        '    - healthCheckFailure',
        '',
      ].join('\n'),
    );
    const fakeFetch: typeof fetch = async () => new Response('down', { status: 503 });
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy() { return { status: 'pass', deployId: 'dpl_new', deployUrl: 'https://new.vercel.app', durationMs: 1 }; },
      async rollback() {
        return { status: 'pass', deployId: 'dpl_prev', rolledBackTo: 'dpl_prev', deployUrl: 'https://prev.vercel.app', durationMs: 30 };
      },
    };
    const bodies: string[] = [];
    const fakeGh = (args: string[], opts?: { body?: string }) => {
      if (opts?.body) bodies.push(opts.body);
      if (args.includes('issues') && args.find((a) => a.includes('comments') && a.includes('repos'))) return '';
      return 'https://github.com/test/repo/pull/42#issuecomment-2';
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        adapterFactory: () => fakeAdapter,
        fetchImpl: fakeFetch,
        sleepImpl: async () => {},
        pr: 42,
        ghImpl: fakeGh,
      });
      assert.equal(code, 1, 'auto-rollback case still exits 1 — original deploy failed');
      const all = bodies.join('\n');
      assert.match(all, /claude-autopilot-deploy/, 'comment uses deploy marker');
      assert.match(all, /dpl_new/, 'failed deploy ID present');
      assert.match(all, /dpl_prev/, 'rolled-back-to ID present');
      assert.match(all, /Auto-rollback|auto-rolled/i);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
node --test --import tsx tests/deploy-rollback.test.ts 2>&1 | tail -25
```

Expected: 2 new tests fail — `pr` and `ghImpl` don't exist on `RunDeployOptions`, and no comment posting happens.

- [ ] **Step 3.3: Wire `--pr` and `ghImpl` into `runDeploy`**

In `src/cli/deploy.ts`:

1. **Add to `RunDeployOptions`** (just below the `pr?: number` already added in Task 1.3):

```typescript
  /**
   * Test seam — injected `gh` CLI runner. Receives argv and an optional
   * `body` (passed via `--body` to avoid argv length limits). Returns
   * stdout. Defaults to the real `gh` shell-out from `core/shell`.
   */
  ghImpl?: (args: string[], opts?: { body?: string; cwd?: string }) => string;
```

2. **Add a `postDeployPrComment` helper near the bottom** of the file (after `printAutoRollbackFailed`):

```typescript
const DEPLOY_COMMENT_MARKER = '<!-- claude-autopilot-deploy -->';

interface DeployCommentInput {
  pr: number;
  cwd: string;
  adapterName: string;
  result: DeployResult;
  healthOutcome: HealthCheckOutcome;
  ghImpl: (args: string[], opts?: { body?: string; cwd?: string }) => string;
}

function buildDeployCommentBody(input: Omit<DeployCommentInput, 'ghImpl' | 'cwd' | 'pr'>): string {
  const { adapterName, result, healthOutcome } = input;
  const lines: string[] = [DEPLOY_COMMENT_MARKER];
  if (result.rolledBackTo) {
    lines.push('## ❌ Deploy auto-rolled back', '');
    lines.push('| Step | Status | URL / ID |');
    lines.push('|---|:---:|---|');
    lines.push(
      `| New deploy \`${result.deployId ?? 'unknown'}\` | ✅ built | ${result.deployUrl ?? '—'} |`,
    );
    if (healthOutcome.status === 'fail') {
      lines.push(`| Health check | ❌ failed | ${healthOutcome.url} |`);
    }
    lines.push(
      `| Auto-rollback to \`${result.rolledBackTo}\` | ✅ promoted | (current production) |`,
    );
  } else if (result.status === 'pass') {
    lines.push('## ✅ Deploy succeeded', '');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push(`| Deploy ID | \`${result.deployId ?? 'unknown'}\` |`);
    if (result.deployUrl) lines.push(`| URL | ${result.deployUrl} |`);
    if (healthOutcome.status === 'pass') {
      lines.push(`| Health check | ✅ ${healthOutcome.url} |`);
    }
  } else {
    lines.push('## ❌ Deploy failed', '');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    if (result.deployId) lines.push(`| Deploy ID | \`${result.deployId}\` |`);
    if (result.deployUrl) lines.push(`| URL | ${result.deployUrl} |`);
    if (result.output) lines.push(`| Reason | ${result.output.replace(/\n/g, ' ')} |`);
  }
  lines.push('', `*adapter=${adapterName} · duration=${(result.durationMs / 1000).toFixed(1)}s*`);
  return lines.join('\n');
}

function postDeployPrComment(input: DeployCommentInput): void {
  const { pr, cwd, ghImpl } = input;
  const body = buildDeployCommentBody(input);
  // Look for an existing comment with our marker.
  const existingId = ghImpl(
    [
      'api',
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      '--jq',
      `[.[] | select(.body | startswith("${DEPLOY_COMMENT_MARKER}")) | .id] | first`,
    ],
    { cwd },
  ).trim();
  if (existingId && /^\d+$/.test(existingId)) {
    ghImpl(
      ['api', `repos/{owner}/{repo}/issues/comments/${existingId}`, '--method', 'PATCH', '--field', 'body=@-'],
      { cwd, body },
    );
  } else {
    ghImpl(['pr', 'comment', String(pr), '--body-file', '-'], { cwd, body });
  }
}

function defaultGhImpl(args: string[], opts?: { body?: string; cwd?: string }): string {
  // Lightweight passthrough — `core/shell.runSafe` already exists for this
  // pattern. We resolve it dynamically to keep the deploy CLI self-contained
  // and to avoid an import cycle if `pr-comment.ts` ever pulls deploy types.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runSafe } = require('../core/shell.ts') as { runSafe: (cmd: string, args: string[], opts: { cwd?: string; input?: string }) => string | null };
  const result = runSafe('gh', args, { cwd: opts?.cwd, input: opts?.body });
  return result ?? '';
}
```

3. **Wire posting into `runDeploy`** — after `printResult(adapter, result);` and before the `if (result.status === 'pass') return 0;` line:

```typescript
  printResult(adapter, result);

  if (opts.pr !== undefined) {
    try {
      postDeployPrComment({
        pr: opts.pr,
        cwd: opts.cwd ?? process.cwd(),
        adapterName: adapter,
        result,
        healthOutcome,
        ghImpl: opts.ghImpl ?? defaultGhImpl,
      });
    } catch (err) {
      console.error(`\x1b[33m[deploy] failed to post PR comment: ${(err as Error)?.message ?? String(err)}\x1b[0m`);
    }
  }

  if (result.status === 'pass') return 0;
  if (result.status === 'in-progress') return 2;
  return 1;
```

4. **Important — `runSafe` may not accept `input`.** Verify the signature in `src/core/shell.ts`. If `runSafe` doesn't accept stdin input, fall back to argv `--body` for short bodies (use a length guard: ≤32K chars is safe for shell args on macOS/Linux). Replace `defaultGhImpl` with:

```typescript
function defaultGhImpl(args: string[], opts?: { body?: string; cwd?: string }): string {
  // Lightweight passthrough using core/shell.runSafe. We pass the body via
  // a temp file when it's set, so `gh ... --body-file <path>` reads it
  // safely without argv length concerns.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runSafe } = require('../core/shell.ts') as { runSafe: (cmd: string, args: string[], opts?: { cwd?: string }) => string | null };
  let argv = args;
  let tmpFile: string | undefined;
  if (opts?.body !== undefined) {
    tmpFile = path.join(os.tmpdir(), `ap-deploy-comment-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, opts.body, 'utf8');
    // Replace any `body=@-` or `--body-file -` with the temp path.
    argv = args.map((a) => (a === '@-' || a === '-' ? tmpFile! : a)).map((a) => (a === 'body=@-' ? `body=@${tmpFile!}` : a));
  }
  try {
    const result = runSafe('gh', argv, { cwd: opts?.cwd });
    return result ?? '';
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    }
  }
}
```

(Add `import * as os from 'node:os';` at the top of the file if not already imported.)

- [ ] **Step 3.4: Wire `--pr` flag in CLI dispatcher**

In `/Users/alexledbetter/Downloads/claude-autopilot/src/cli/index.ts` around line 800-811 (the `case 'deploy':` block, the path that calls `runDeploy`):

Replace:

```typescript
    const ref = flag('ref');
    const commitSha = flag('sha');
    const watch = boolFlag('watch');
    const code = await runDeploy({
      configPath: config,
      adapterOverride: adapterArg as 'vercel' | 'generic' | undefined,
      ref,
      commitSha,
      watch,
    });
    process.exit(code);
```

with:

```typescript
    const ref = flag('ref');
    const commitSha = flag('sha');
    const watch = boolFlag('watch');
    const prRaw = flag('pr');
    let prNum: number | undefined;
    if (prRaw !== undefined) {
      const n = parseInt(prRaw, 10);
      if (Number.isNaN(n) || n <= 0) {
        console.error(`\x1b[31m[claude-autopilot] --pr must be a positive integer, got "${prRaw}"\x1b[0m`);
        process.exit(1);
      }
      prNum = n;
    }
    const code = await runDeploy({
      configPath: config,
      adapterOverride: adapterArg as 'vercel' | 'generic' | undefined,
      ref,
      commitSha,
      watch,
      pr: prNum,
    });
    process.exit(code);
```

Also update the help text near line 337-343 to document `--pr <n>`. Find the `Options (deploy):` block and add a line:

```
  --pr <n>                     Post upserting deploy summary comment on the PR
```

- [ ] **Step 3.5: Run the new tests**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
node --test --import tsx tests/deploy-rollback.test.ts 2>&1 | tail -30
```

Expected: 9 tests pass (2 Task 1 + 5 Task 2 + 2 Task 3).

- [ ] **Step 3.6: Run the full suite**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
npm test 2>&1 | tail -10
```

Expected: total = baseline + 9, all green.

- [ ] **Step 3.7: TypeScript check**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
npx tsc --noEmit 2>&1 | tail -20
```

Expected: zero errors. (This repo, unlike Delegance, does NOT have `ignoreBuildErrors`.)

- [ ] **Step 3.8: Commit**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
git add src/cli/deploy.ts src/cli/index.ts tests/deploy-rollback.test.ts
git commit -m "feat(deploy): Phase 4 — --pr flag posts auto-rollback-aware PR comment"
```

---

## Task 4: Mark Phase 4 done in spec

**Files:**
- Modify: `/Users/alexledbetter/Downloads/claude-autopilot/docs/specs/v5.4-vercel-adapter.md`

- [ ] **Step 4.1: Update spec status header and phase list**

In `docs/specs/v5.4-vercel-adapter.md`, find the line:

```
4. **Phase 4 (~1h)** — Auto-rollback wired to `rollbackOn: [healthCheckFailure]`. When health check fails after deploy, fetch previous prod deploy ID and promote it.
```

Append `**[done — PR <n>]**` (we'll fill the PR number after open):

```
4. **Phase 4 (~1h)** — Auto-rollback wired to `rollbackOn: [healthCheckFailure]`. When health check fails after deploy, fetch previous prod deploy ID and promote it. **[done]**
```

- [ ] **Step 4.2: Final test run + commit**

```bash
cd /Users/alexledbetter/Downloads/claude-autopilot
npm test 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
git add docs/specs/v5.4-vercel-adapter.md
git commit -m "docs(spec): mark v5.4 Phase 4 done"
```

Expected: all tests pass, tsc clean, commit lands.

---

## Self-Review Notes

**Spec coverage check:**
- ✅ Schema validates `rollbackOn` with both values — already shipped in Phase 1; verified in pre-existing tests.
- ✅ Deploy orchestration invokes `adapter.rollback` on health-check failure when configured — Task 2.
- ✅ `result.rolledBackTo` populated — Task 2.
- ✅ CLI distinct yellow `🔄` line — Task 2 via `printAutoRollback`.
- ✅ PR comment shows both URLs — Task 3 via `buildDeployCommentBody`.
- ✅ Tests for positive, negative, edge — Task 2 (5 tests) + Task 3 (2 tests) + Task 1 (2 tests).
- ✅ `smokeTestFailure` accepted by schema but not wired — confirmed by negative test in Task 2.
- ✅ Auto-rollback on by default when configured (no extra flag) — Task 2 logic.
- ✅ No new methods on `DeployAdapter` contract — verified, all changes in `runDeploy`.

**Type consistency:** `HealthCheckOutcome` discriminated union used the same way in Task 1 (declaration), Task 2 (printAutoRollback signature), Task 3 (postDeployPrComment input). `DeployResult.rolledBackTo` is the existing field from Phase 3 — reused, not redeclared.

**No placeholders:** every step has either exact code or exact commands. The single open variable is `<n>` for the PR number in Task 4.1, which is filled by autopilot's PR-creation step.
