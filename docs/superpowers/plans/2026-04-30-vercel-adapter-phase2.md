# Vercel Deploy Adapter Phase 2 — Log Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time build log streaming to the Vercel deploy adapter so `claude-autopilot deploy --watch` pipes Vercel's NDJSON event stream to stderr while the deploy runs.

**Architecture:** Optional `streamLogs?(input): AsyncIterable<DeployLogLine>` method on `DeployAdapter`. Vercel implements via `GET /v2/deployments/<id>/events?builds=1&follow=1` (NDJSON, with classic-SSE `data: ` prefix tolerated). Generic adapter omits the method (the `undefined` is the "not supported" signal). CLI wires `--watch` by passing an `onDeployStart(deployId)` callback into `deploy()`; when fired, the CLI starts the stream on a background promise and pipes `DeployLogLine.text` to stderr until deploy resolves, then aborts.

**Tech Stack:** TypeScript (strict-ish), Node 18+ native fetch (web `ReadableStream`), `node:test` + `node:assert/strict`, no new deps.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/adapters/deploy/types.ts` | **Modify** | Add `DeployStreamLogsInput`, `DeployLogLine`; add `onDeployStart?` to `DeployInput`; add `streamLogs?` to `DeployAdapter` |
| `src/adapters/deploy/vercel.ts` | **Modify** | Add `streamLogs()` async generator + private NDJSON/SSE parser. Add 1-line `onDeployStart` call in `deploy()` after POST resolves |
| `src/adapters/deploy/generic.ts` | **No change** | `streamLogs` stays absent (optional method). Confirm `onDeployStart` is intentionally not called |
| `src/adapters/deploy/index.ts` | **No change** | Already re-exports `* from './types.ts'` so new types are auto-exported |
| `src/cli/deploy.ts` | **Modify** | Accept `watch: boolean` in `RunDeployOptions`; build AbortController; pass `onDeployStart` callback; pipe stream to stderr; abort on deploy resolve |
| `src/cli/index.ts` | **Modify** | Add `--watch` to deploy subcommand using `boolFlag('watch')`; pass through to `runDeploy` |
| `tests/deploy-vercel.test.ts` | **Modify** | Add ~10 new `streamLogs` and `onDeployStart` tests using a `mockReadableStream` helper |
| `tests/deploy-cli.test.ts` | **Modify** | Add ~3 new `--watch` integration tests with a fake adapter |
| `tests/deploy-types.test.ts` | **Modify** | Add ~2 type-export and optional-method tests |

No new files. Phase 1 files extended in place.

---

## Task 1: Extend `types.ts` with new interfaces

**Files:**
- Modify: `src/adapters/deploy/types.ts`
- Test: `tests/deploy-types.test.ts`

- [ ] **Step 1: Write the failing tests**

Append the following test block to `tests/deploy-types.test.ts` (keep existing tests intact, add at the end inside the existing `describe`, or as a new `describe` block):

```ts
import type {
  DeployAdapter,
  DeployStreamLogsInput,
  DeployLogLine,
  DeployInput,
} from '../src/adapters/deploy/types.ts';

describe('DeployAdapter Phase 2 surface', () => {
  it('exports DeployStreamLogsInput and DeployLogLine with expected shape', () => {
    const input: DeployStreamLogsInput = { deployId: 'dpl_x' };
    const line: DeployLogLine = { timestamp: 1, text: 'hello' };
    assert.equal(input.deployId, 'dpl_x');
    assert.equal(line.text, 'hello');
  });

  it('streamLogs is optional on DeployAdapter (omitting compiles)', () => {
    const noStream: DeployAdapter = {
      name: 'noop',
      deploy: async () => ({ status: 'pass', durationMs: 0 }),
    };
    assert.equal(noStream.streamLogs, undefined);
  });

  it('onDeployStart is an optional callback on DeployInput', () => {
    let captured: string | undefined;
    const input: DeployInput = { onDeployStart: (id) => { captured = id; } };
    input.onDeployStart?.('dpl_test');
    assert.equal(captured, 'dpl_test');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/deploy-types.test.ts`
Expected: FAIL with `Cannot find name 'DeployStreamLogsInput'` and `'onDeployStart' does not exist on type 'DeployInput'`.

- [ ] **Step 3: Add the new types to `src/adapters/deploy/types.ts`**

Insert into the existing file (do NOT replace the file — extend it). After `DeployRollbackInput` and before `DeployAdapter`, add:

```ts
/**
 * Input to a one-shot log-streaming subscription.
 *
 * Returned `AsyncIterable` yields `DeployLogLine`s as the platform emits them.
 * Consumers iterate with `for await ... of`. Cancellation is via the
 * `signal` — once aborted, the underlying transport is torn down and the
 * iterator finishes (or throws `AbortError`, depending on adapter).
 */
export interface DeployStreamLogsInput {
  deployId: string;
  signal?: AbortSignal;
}

/**
 * A single log line surfaced from the platform.
 *
 * Fields beyond `timestamp` and `text` are best-effort — adapters populate
 * what they have. Consumers MUST NOT rely on `level` or `source` being set.
 */
export interface DeployLogLine {
  /** Milliseconds since epoch — from the platform if provided, else when received locally. */
  timestamp: number;
  /** Build phase or component (e.g. 'build', 'deploy'). Optional. */
  source?: string;
  /** 'info' | 'warn' | 'error' | 'stdout' | 'stderr' — adapter-defined. Optional. */
  level?: string;
  /** Log text, no trailing newline. */
  text: string;
}
```

Add `onDeployStart?` to the existing `DeployInput` interface (insert as a new field before the closing brace):

```ts
  /**
   * Fired exactly once with the platform-native deploy ID as soon as it's
   * known. Adapters that obtain the ID synchronously (Vercel returns it from
   * the create-deployment POST) MUST call this immediately after the POST
   * resolves but before polling begins. Adapters with no discrete ID (the
   * generic shell adapter) do NOT call it.
   *
   * Consumers use this to start side-channel work in parallel with the
   * deploy — most notably log streaming via `--watch`.
   */
  onDeployStart?: (deployId: string) => void;
```

Add `streamLogs?` to the existing `DeployAdapter` interface:

```ts
  /**
   * Subscribe to real-time build logs. Optional — adapters without a
   * platform API for log streaming (e.g. generic shell) omit this method.
   */
  streamLogs?(input: DeployStreamLogsInput): AsyncIterable<DeployLogLine>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/deploy-types.test.ts`
Expected: PASS, all original tests still pass + the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/deploy/types.ts tests/deploy-types.test.ts
git commit -m "feat(deploy): Phase 2 — add DeployStreamLogsInput, DeployLogLine, onDeployStart, optional streamLogs"
```

---

## Task 2: Wire `onDeployStart` into Vercel `deploy()`

**Files:**
- Modify: `src/adapters/deploy/vercel.ts`
- Test: `tests/deploy-vercel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/deploy-vercel.test.ts` inside the existing `describe('VercelDeployAdapter', () => { ... })` block (find the closing `});` of that describe and add this `it` just before it):

```ts
  it('fires onDeployStart with the new deployment id immediately after POST', async () => {
    const { fetch } = mockFetch([
      res(200, { id: 'dpl_start', url: 'app.vercel.app' }),
      res(200, { id: 'dpl_start', readyState: 'READY', url: 'app.vercel.app' }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const seen: string[] = [];
    const result = await adapter.deploy({
      onDeployStart: (id) => { seen.push(id); },
    });
    assert.deepEqual(seen, ['dpl_start']);
    assert.equal(result.status, 'pass');
  });

  it('does not fire onDeployStart when create POST returns no id (would have already thrown)', async () => {
    // Sanity check: the adapter throws when there's no id, so onDeployStart never fires.
    // (Documented behavior — this test exists to lock in that no half-fired callback escapes.)
    const { fetch } = mockFetch([res(200, { url: 'no-id.vercel.app' })]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const seen: string[] = [];
    await assert.rejects(
      adapter.deploy({ onDeployStart: (id) => { seen.push(id); } }),
      /no deployment id/,
    );
    assert.deepEqual(seen, []);
  });
```

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `npx tsx --test tests/deploy-vercel.test.ts`
Expected: the new "fires onDeployStart" test fails with `Expected: ['dpl_start'], got: []`. The "does not fire" test should already pass.

- [ ] **Step 3: Add the one-line callback in `deploy()`**

In `src/adapters/deploy/vercel.ts`, locate the `deploy()` method. Find the block (around line 134-140 in current Phase 1 source):

```ts
    const created = (await res.json()) as VercelDeployResponse;
    if (!created.id) {
      throw new GuardrailError(
        `Vercel returned no deployment id (got: ${JSON.stringify(created).slice(0, 200)})`,
        { code: 'adapter_bug', provider: 'vercel' },
      );
    }
    return this.pollUntilTerminal(created.id, start, input.signal);
```

Insert the `onDeployStart` call between the id-check and `pollUntilTerminal`:

```ts
    const created = (await res.json()) as VercelDeployResponse;
    if (!created.id) {
      throw new GuardrailError(
        `Vercel returned no deployment id (got: ${JSON.stringify(created).slice(0, 200)})`,
        { code: 'adapter_bug', provider: 'vercel' },
      );
    }
    // Phase 2: fire onDeployStart so callers (e.g. --watch) can subscribe
    // to logs in parallel with polling. Wrap in try/catch — a buggy callback
    // must not crash the deploy.
    try {
      input.onDeployStart?.(created.id);
    } catch {
      /* swallow — observability concern only */
    }
    return this.pollUntilTerminal(created.id, start, input.signal);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/deploy-vercel.test.ts`
Expected: all existing tests still pass + 2 new ones pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/deploy/vercel.ts tests/deploy-vercel.test.ts
git commit -m "feat(deploy/vercel): Phase 2 — fire onDeployStart immediately after POST"
```

---

## Task 3: Implement Vercel `streamLogs()` — happy path

**Files:**
- Modify: `src/adapters/deploy/vercel.ts`
- Test: `tests/deploy-vercel.test.ts`

- [ ] **Step 1: Add the `mockReadableStream` helper to the test file**

At the top of `tests/deploy-vercel.test.ts`, after the existing `mockFetch` helper, add:

```ts
/**
 * Build a minimal Response whose `body` is a web ReadableStream that yields
 * the given chunks (UTF-8 encoded). When `error` is set, the stream rejects
 * the next read with that error.
 */
function streamingRes(status: number, chunks: Array<string>, error?: Error): Response {
  let i = 0;
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (error && i === chunks.length) throw error;
      if (i >= chunks.length) return { done: true };
      const chunk = chunks[i++]!;
      return { done: false, value: new TextEncoder().encode(chunk) };
    },
    cancel() { return Promise.resolve(); },
    releaseLock() {},
  };
  const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    text: async () => chunks.join(''),
    json: async () => JSON.parse(chunks.join('')),
  } as unknown as Response;
}
```

- [ ] **Step 2: Write the failing happy-path test**

Add a new `describe` block at the bottom of `tests/deploy-vercel.test.ts`:

```ts
describe('VercelDeployAdapter.streamLogs', () => {
  it('yields DeployLogLines parsed from a mocked NDJSON stream', async () => {
    const events = [
      JSON.stringify({ type: 'stdout', payload: { text: 'hello' }, created: 1700000000000 }) + '\n',
      JSON.stringify({ type: 'stderr', payload: { text: 'warn x' }, created: 1700000000001 }) + '\n',
      JSON.stringify({ type: 'state', payload: { state: 'BUILDING' }, created: 1700000000002 }) + '\n',
      JSON.stringify({ type: 'stdout', payload: { text: 'done' }, created: 1700000000003 }) + '\n',
    ];
    const { fetch } = mockFetch([streamingRes(200, [events.join('')])]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const lines: Array<{ text: string; level?: string }> = [];
    for await (const line of adapter.streamLogs!({ deployId: 'dpl_x' })) {
      lines.push({ text: line.text, level: line.level });
    }
    assert.deepEqual(lines, [
      { text: 'hello', level: 'stdout' },
      { text: 'warn x', level: 'stderr' },
      { text: 'done', level: 'stdout' },
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test tests/deploy-vercel.test.ts`
Expected: FAIL — `adapter.streamLogs` is `undefined` (TypeError on `streamLogs!(...)` call).

- [ ] **Step 4: Implement `streamLogs` in `vercel.ts`**

Add this method to the `VercelDeployAdapter` class in `src/adapters/deploy/vercel.ts`, placed after the existing `status()` method and before the `// private helpers` comment:

```ts
  async *streamLogs(input: DeployStreamLogsInput): AsyncGenerator<DeployLogLine> {
    const url = this.urlWithTeam(
      `${VERCEL_API_BASE}/v2/deployments/${encodeURIComponent(input.deployId)}/events?builds=1&follow=1`,
    );
    const res = await this.fetchEventsWithRetry(url, input.signal);
    await this.assertOkOrThrow(res, 'stream logs');
    if (!res.body) {
      throw new GuardrailError(
        `Vercel events response had no body for ${input.deployId}`,
        { code: 'adapter_bug', provider: 'vercel' },
      );
    }
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
      while (true) {
        if (input.signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) {
          // Flush a trailing partial line if present.
          if (buf.length > 0) {
            const line = parseEventLine(buf);
            if (line) yield line;
          }
          return;
        }
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const raw = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const line = parseEventLine(raw);
          if (line) yield line;
          nl = buf.indexOf('\n');
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }
```

Add the new import for the types at the top of the file (extend the existing `import type { ... } from './types.ts'`):

```ts
import type {
  DeployAdapter,
  DeployInput,
  DeployLogLine,
  DeployResult,
  DeployStatusInput,
  DeployStatusResult,
  DeployStreamLogsInput,
} from './types.ts';
```

Add the standalone `parseEventLine` helper at the bottom of the file (after `safeReadBody`):

```ts
/**
 * Parse a single line from Vercel's events endpoint into a DeployLogLine.
 *
 * Accepts both raw NDJSON and classic SSE `data: {...}` lines. Returns
 * `null` for events we don't surface (state changes, completes, heartbeats)
 * and for lines that fail to JSON-parse — silently skipping a malformed
 * event is preferable to crashing a long-running stream.
 */
function parseEventLine(raw: string): DeployLogLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // SSE comment / heartbeat lines start with ':'
  if (trimmed.startsWith(':')) return null;
  // SSE event/id lines — not data, skip
  if (trimmed.startsWith('event:') || trimmed.startsWith('id:') || trimmed.startsWith('retry:')) return null;
  // Strip 'data: ' prefix if present (classic SSE)
  const jsonPart = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!jsonPart) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const ev = parsed as { type?: string; payload?: { text?: string }; created?: number; date?: number };
  // Only surface log-bearing event types. Vercel emits 'stdout'/'stderr' for
  // build output; 'state' / 'complete' / etc. are deploy lifecycle events
  // that the polling loop already handles.
  if (ev.type !== 'stdout' && ev.type !== 'stderr') return null;
  const text = typeof ev.payload?.text === 'string' ? ev.payload.text : '';
  if (!text) return null;
  const ts = typeof ev.created === 'number' ? ev.created : typeof ev.date === 'number' ? ev.date : Date.now();
  return { timestamp: ts, level: ev.type, text };
}
```

Add the `fetchEventsWithRetry` private method to the class (place after `fetchWithRetry`):

```ts
  /**
   * Like `fetchWithRetry` but optimized for the events endpoint:
   * - 404 right after a deploy POST is a known race (deploy hasn't propagated
   *   to the events service yet). Retry up to 3 times with 500ms backoff.
   * - 5xx behaves the same as `fetchWithRetry`.
   * - Cancels cleanly on AbortError.
   *
   * Returns the `Response` so the caller can `assertOkOrThrow` on a final
   * non-OK status (e.g. 401 still bubbles immediately on attempt 1).
   */
  private async fetchEventsWithRetry(
    url: string,
    signal: AbortSignal | undefined,
    attempts = 3,
    baseMs = 500,
  ): Promise<Response> {
    let lastRes: Response | undefined;
    for (let i = 0; i < attempts; i++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { ...this.headers(), Accept: 'text/event-stream' },
          signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        if (i < attempts - 1) {
          await this.sleep(baseMs * 2 ** i);
          continue;
        }
        throw new GuardrailError(
          `Vercel events endpoint unreachable after ${attempts} attempts: ${(err as Error)?.message ?? String(err)}`,
          { code: 'transient_network', provider: 'vercel' },
        );
      }
      lastRes = res;
      // 404 after create-deployment is the known race — retry.
      if (res.status === 404 && i < attempts - 1) {
        await this.sleep(baseMs * 2 ** i);
        continue;
      }
      // 5xx is transient — retry.
      if (res.status >= 500 && res.status < 600 && i < attempts - 1) {
        await this.sleep(baseMs * 2 ** i);
        continue;
      }
      return res;
    }
    return lastRes!;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/deploy-vercel.test.ts`
Expected: all existing tests still pass + the new happy-path streamLogs test passes.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/deploy/vercel.ts tests/deploy-vercel.test.ts
git commit -m "feat(deploy/vercel): Phase 2 — streamLogs() with NDJSON parser, 404 retry, abort handling"
```

---

## Task 4: streamLogs — partial chunks, malformed JSON, SSE prefix tests

**Files:**
- Modify: `tests/deploy-vercel.test.ts` (no source changes — code from Task 3 already handles these cases; this task verifies)

- [ ] **Step 1: Write the partial-chunks test**

Append inside the `describe('VercelDeployAdapter.streamLogs', ...)` block:

```ts
  it('handles partial chunks across reads (a line split mid-event)', async () => {
    const fullLine = JSON.stringify({ type: 'stdout', payload: { text: 'split-line' }, created: 1700000000000 });
    const halfA = fullLine.slice(0, 20);
    const halfB = fullLine.slice(20) + '\n';
    const { fetch } = mockFetch([streamingRes(200, [halfA, halfB])]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const lines: string[] = [];
    for await (const line of adapter.streamLogs!({ deployId: 'dpl_x' })) {
      lines.push(line.text);
    }
    assert.deepEqual(lines, ['split-line']);
  });
```

- [ ] **Step 2: Write the malformed-JSON test**

Append:

```ts
  it('tolerates malformed JSON by skipping the bad line', async () => {
    const good = JSON.stringify({ type: 'stdout', payload: { text: 'good-1' }, created: 1700000000000 }) + '\n';
    const garbage = '{not really json' + '\n';
    const good2 = JSON.stringify({ type: 'stdout', payload: { text: 'good-2' }, created: 1700000000001 }) + '\n';
    const { fetch } = mockFetch([streamingRes(200, [good + garbage + good2])]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const lines: string[] = [];
    for await (const line of adapter.streamLogs!({ deployId: 'dpl_x' })) {
      lines.push(line.text);
    }
    assert.deepEqual(lines, ['good-1', 'good-2']);
  });
```

- [ ] **Step 3: Write the SSE-prefix test**

Append:

```ts
  it('handles SSE-style "data: {...}" prefix in addition to raw NDJSON', async () => {
    const event = JSON.stringify({ type: 'stdout', payload: { text: 'sse-line' }, created: 1700000000000 });
    const stream = `event: log\ndata: ${event}\n\n: heartbeat\nid: 42\n`;
    const { fetch } = mockFetch([streamingRes(200, [stream])]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const lines: string[] = [];
    for await (const line of adapter.streamLogs!({ deployId: 'dpl_x' })) {
      lines.push(line.text);
    }
    assert.deepEqual(lines, ['sse-line']);
  });

  it('filters non-log event types (state, complete) so only stdout/stderr surface', async () => {
    const stream = [
      JSON.stringify({ type: 'state', payload: { state: 'BUILDING' }, created: 1 }) + '\n',
      JSON.stringify({ type: 'complete', payload: {}, created: 2 }) + '\n',
      JSON.stringify({ type: 'stdout', payload: { text: 'survivor' }, created: 3 }) + '\n',
    ].join('');
    const { fetch } = mockFetch([streamingRes(200, [stream])]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const lines: string[] = [];
    for await (const line of adapter.streamLogs!({ deployId: 'dpl_x' })) {
      lines.push(line.text);
    }
    assert.deepEqual(lines, ['survivor']);
  });
```

- [ ] **Step 4: Run all four new tests**

Run: `npx tsx --test tests/deploy-vercel.test.ts`
Expected: all 4 new tests pass without code changes (parser already handles them — this task verifies by tests).

- [ ] **Step 5: Commit**

```bash
git add tests/deploy-vercel.test.ts
git commit -m "test(deploy/vercel): cover streamLogs partial chunks, malformed JSON, SSE prefix, event filtering"
```

---

## Task 5: streamLogs — abort + error tests

**Files:**
- Modify: `tests/deploy-vercel.test.ts`

- [ ] **Step 1: Write the abort test**

Append inside the same `describe`:

```ts
  it('honors AbortSignal — aborts the stream cleanly when caller aborts', async () => {
    const controller = new AbortController();
    let stopped = false;
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        if (controller.signal.aborted) {
          stopped = true;
          return { done: true };
        }
        // Emit one line, then mark abort so next read returns done.
        controller.abort();
        return { done: false, value: new TextEncoder().encode(
          JSON.stringify({ type: 'stdout', payload: { text: 'before-abort' }, created: 1 }) + '\n',
        ) };
      },
      cancel() { stopped = true; return Promise.resolve(); },
      releaseLock() {},
    };
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const fakeRes = { ok: true, status: 200, body, text: async () => '', json: async () => ({}) } as unknown as Response;
    const fetch = (async () => fakeRes) as unknown as typeof globalThis.fetch;
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const lines: string[] = [];
    for await (const line of adapter.streamLogs!({ deployId: 'dpl_x', signal: controller.signal })) {
      lines.push(line.text);
    }
    assert.deepEqual(lines, ['before-abort']);
    // The iterator must finish promptly after abort, not hang.
    assert.equal(stopped, true);
  });
```

- [ ] **Step 2: Write the 401 auth test**

```ts
  it('throws GuardrailError(code:auth) on 401', async () => {
    const { fetch } = mockFetch([res(401, { error: { message: 'no auth' } })]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    await assert.rejects(
      (async () => {
        for await (const _line of adapter.streamLogs!({ deployId: 'dpl_x' })) { /* noop */ }
      })(),
      (err: unknown) => err instanceof GuardrailError && err.code === 'auth',
    );
  });
```

- [ ] **Step 3: Write the 404 retry-then-fail test**

```ts
  it('retries 404 up to 3 times then throws GuardrailError(code:invalid_config)', async () => {
    const { fetch, calls } = mockFetch([
      res(404, { error: { message: 'not propagated yet' } }),
      res(404, { error: { message: 'not propagated yet' } }),
      res(404, { error: { message: 'still missing' } }),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    await assert.rejects(
      (async () => {
        for await (const _line of adapter.streamLogs!({ deployId: 'dpl_x' })) { /* noop */ }
      })(),
      (err: unknown) => err instanceof GuardrailError && err.code === 'invalid_config',
    );
    assert.equal(calls.length, 3);
  });

  it('retries 404 then succeeds when the events service catches up', async () => {
    const event = JSON.stringify({ type: 'stdout', payload: { text: 'finally' }, created: 1 }) + '\n';
    const { fetch, calls } = mockFetch([
      res(404, { error: { message: 'not yet' } }),
      streamingRes(200, [event]),
    ]);
    const adapter = new VercelDeployAdapter({
      token: 'tok_test',
      project: 'my-app',
      fetchImpl: fetch,
      sleepImpl: sleepNoop,
      nowImpl: fixedNow,
    });
    const lines: string[] = [];
    for await (const line of adapter.streamLogs!({ deployId: 'dpl_x' })) {
      lines.push(line.text);
    }
    assert.deepEqual(lines, ['finally']);
    assert.equal(calls.length, 2);
  });
```

- [ ] **Step 4: Run all new tests**

Run: `npx tsx --test tests/deploy-vercel.test.ts`
Expected: all 4 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/deploy-vercel.test.ts
git commit -m "test(deploy/vercel): cover streamLogs abort, 401 auth, 404 retry-then-fail and retry-then-succeed"
```

---

## Task 6: Wire `--watch` into CLI `runDeploy`

**Files:**
- Modify: `src/cli/deploy.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/deploy-cli.test.ts`

- [ ] **Step 1: Write the failing CLI tests**

Append to `tests/deploy-cli.test.ts` (after the existing `describe('runDeploy CLI', ...)`). Add a new `describe` block:

```ts
import type { DeployAdapter } from '../src/adapters/deploy/types.ts';

/**
 * runDeploy accepts an `adapterFactory` injection point for tests so we can
 * assert on the adapter's behavior without going through the real factory
 * (which requires VERCEL_TOKEN etc.). The new injection point is added in
 * src/cli/deploy.ts in this task.
 */
describe('runDeploy --watch', () => {
  it('opts in: streamLogs is invoked and lines reach stderr', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), 'deploy:\n  adapter: vercel\n  project: my-app\n');
    const original = console.error;
    let stderr = '';
    console.error = (msg: string) => { stderr += msg + '\n'; };
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;

    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy(input) {
        // Fire onDeployStart synchronously like real Vercel does after POST.
        input.onDeployStart?.('dpl_fake');
        // Give the streamLogs loop one event-loop tick to consume.
        await new Promise((r) => setImmediate(r));
        return { status: 'pass', deployId: 'dpl_fake', durationMs: 10 };
      },
      async *streamLogs(_input) {
        yield { timestamp: 1, level: 'stdout', text: 'streamed-line-1' };
        yield { timestamp: 2, level: 'stdout', text: 'streamed-line-2' };
      },
    };

    try {
      const code = await runDeploy({
        cwd: dir,
        watch: true,
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 0);
      const allStderr = stderrWrites.join('');
      assert.match(allStderr, /streamed-line-1/);
      assert.match(allStderr, /streamed-line-2/);
    } finally {
      console.error = original;
      process.stderr.write = origWrite;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('on generic adapter without streamLogs, prints unsupported warning and continues', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), 'deploy:\n  adapter: generic\n  deployCommand: echo http://x.test\n');
    const original = console.error;
    let stderr = '';
    console.error = (msg: string) => { stderr += msg + '\n'; };

    const fakeAdapter: DeployAdapter = {
      name: 'generic',
      async deploy() { return { status: 'pass', deployUrl: 'http://x.test', durationMs: 5 }; },
      // No streamLogs method.
    };

    try {
      const code = await runDeploy({
        cwd: dir,
        watch: true,
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 0);
      assert.match(stderr, /--watch ignored/);
      assert.match(stderr, /generic/);
    } finally {
      console.error = original;
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('without --watch, streamLogs is not invoked even when supported', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), 'deploy:\n  adapter: vercel\n  project: my-app\n');
    let streamCalls = 0;
    const fakeAdapter: DeployAdapter = {
      name: 'vercel',
      async deploy(input) {
        input.onDeployStart?.('dpl_fake');
        return { status: 'pass', deployId: 'dpl_fake', durationMs: 10 };
      },
      // eslint-disable-next-line require-yield
      async *streamLogs() { streamCalls++; },
    };
    try {
      const code = await runDeploy({
        cwd: dir,
        watch: false,
        adapterFactory: () => fakeAdapter,
      });
      assert.equal(code, 0);
      assert.equal(streamCalls, 0);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/deploy-cli.test.ts`
Expected: FAIL with `'watch' does not exist on type 'RunDeployOptions'` and `'adapterFactory' does not exist`.

- [ ] **Step 3: Extend `RunDeployOptions` and add `adapterFactory`**

Edit `src/cli/deploy.ts`. Update the `RunDeployOptions` interface:

```ts
export interface RunDeployOptions {
  configPath?: string;
  /** When set, overrides `deploy.adapter` from config. */
  adapterOverride?: 'vercel' | 'generic';
  ref?: string;
  commitSha?: string;
  cwd?: string;
  /** Phase 2 — when true, subscribe to streamLogs() and pipe to stderr. */
  watch?: boolean;
  /**
   * Test seam — allows injecting a fake DeployAdapter without going through
   * the real factory (which requires VERCEL_TOKEN etc.). Production callers
   * must NOT set this.
   */
  adapterFactory?: (config: DeployConfig) => DeployAdapter;
}
```

Add the `DeployAdapter` import (extend the existing import block at the top):

```ts
import type { DeployAdapter, DeployConfig, DeployResult } from '../adapters/deploy/types.ts';
```

- [ ] **Step 4: Replace the deploy block with the watch-aware version**

In `src/cli/deploy.ts`, locate the block that currently reads:

```ts
  let result: DeployResult;
  try {
    const deployAdapter = createDeployAdapter(merged);
    result = await deployAdapter.deploy({
      ref: opts.ref,
      commitSha: opts.commitSha,
    });
  } catch (err) {
    console.error(formatErr(`deploy via ${adapter} failed`, err));
    return 1;
  }
```

Replace with:

```ts
  let result: DeployResult;
  let streamCleanup: (() => void) | undefined;
  try {
    const deployAdapter = (opts.adapterFactory ?? createDeployAdapter)(merged);

    // --watch: opt into log streaming. We start the stream from inside an
    // onDeployStart callback so it begins as soon as the platform returns
    // an ID, in parallel with the (still-running) deploy.
    let onDeployStart: ((deployId: string) => void) | undefined;
    let streamPromise: Promise<void> | undefined;
    let streamController: AbortController | undefined;
    if (opts.watch) {
      if (typeof deployAdapter.streamLogs === 'function') {
        streamController = new AbortController();
        const streamFn = deployAdapter.streamLogs.bind(deployAdapter);
        const ctrlSignal = streamController.signal;
        onDeployStart = (deployId: string) => {
          streamPromise = (async () => {
            try {
              for await (const line of streamFn({ deployId, signal: ctrlSignal })) {
                process.stderr.write(`[deploy:${deployAdapter.name}] ${line.text}\n`);
              }
            } catch (err) {
              if (!(err instanceof Error && err.name === 'AbortError')) {
                console.error(`\x1b[2m[deploy] log stream ended: ${(err as Error)?.message ?? String(err)}\x1b[0m`);
              }
            }
          })();
        };
      } else {
        console.error(
          `\x1b[33m[deploy] --watch ignored — adapter "${deployAdapter.name}" does not support log streaming\x1b[0m`,
        );
      }
    }

    streamCleanup = () => {
      streamController?.abort();
    };

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
  } catch (err) {
    streamCleanup?.();
    console.error(formatErr(`deploy via ${adapter} failed`, err));
    return 1;
  }
```

- [ ] **Step 5: Wire `--watch` flag in `src/cli/index.ts`**

Locate the `case 'deploy':` block (around line 760). Replace its body:

```ts
  case 'deploy': {
    const config = flag('config');
    const adapterArg = flag('adapter');
    if (adapterArg && !['vercel', 'generic'].includes(adapterArg)) {
      console.error(`\x1b[31m[claude-autopilot] --adapter must be "vercel" or "generic"\x1b[0m`);
      process.exit(1);
    }
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
    break;
  }
```

Update the `Options (deploy):` help block (around line 337) to include `--watch`:

Find the block:

```
Options (deploy):
  --adapter <vercel|generic>   Override deploy.adapter from config
  --config <path>              Path to guardrail.config.yaml (default: ./guardrail.config.yaml)
  --ref <ref>                  Git ref (branch / tag) to deploy
  --sha <commit>               Specific commit SHA to deploy
```

(The exact prior content may differ — the rule is: add `--watch` directly under `--sha`.)

Add this line:

```
  --watch                      Stream build logs to stderr in real time (Vercel only)
```

- [ ] **Step 6: Run CLI tests to verify they pass**

Run: `npx tsx --test tests/deploy-cli.test.ts`
Expected: all existing + 3 new tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/cli/deploy.ts src/cli/index.ts tests/deploy-cli.test.ts
git commit -m "feat(cli): add --watch flag — stream Vercel build logs to stderr in real time"
```

---

## Task 7: Full test sweep + tsc

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS — count went from 891 baseline to ~903+ (12 new tests across types, vercel, cli).

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: clean. If errors appear in files I touched (`types.ts`, `vercel.ts`, `deploy.ts`, `index.ts`, the three test files), fix them before proceeding.

- [ ] **Step 3: If any test fails or tsc complains**

- Read the failing test name and message
- Open the file, fix the issue minimally
- Re-run only the affected test file: `npx tsx --test tests/<file>.test.ts`
- Re-run the full sweep once green

- [ ] **Step 4: Commit any fixes**

If fixes were needed:

```bash
git add -A
git commit -m "fix: address tsc/test fallout from Phase 2 streamLogs implementation"
```

If no fixes were needed: skip the commit.

---

## Task 8: Push branch + open PR

**Files:** none (git/gh operations)

- [ ] **Step 1: Verify branch state**

Run: `git status -s && git log --oneline -8 origin/master..HEAD`
Expected: clean working tree, ~6 commits on the feature branch (1 spec + 1 plan + 5 implementation).

- [ ] **Step 2: Push the branch**

Run: `git push -u origin feature/v5.4-vercel-adapter-phase2`
Expected: branch pushed to GitHub. **DO NOT** push tags. **DO NOT** trigger any release workflow.

- [ ] **Step 3: Open the PR**

Run:

```bash
gh pr create --base master --title "feat(v5.4): Vercel deploy adapter — Phase 2 (log streaming)" --body "$(cat <<'EOF'
## Summary

Phase 2 of the v5.4 Vercel adapter spec — real-time build log streaming.

- `DeployAdapter.streamLogs?(input): AsyncIterable<DeployLogLine>` (optional)
- Vercel adapter implements via `GET /v2/deployments/<id>/events?builds=1&follow=1`
  - NDJSON parser with classic-SSE `data:` prefix tolerated
  - Skips non-log event types (`state`, `complete`, heartbeats)
  - Tolerates malformed JSON lines without crashing the stream
  - Retries 404 (post-create race) up to 3x with 500ms backoff
  - Honors AbortSignal for clean cancellation
- Generic adapter omits `streamLogs` (the optional method's absence is the "not supported" signal)
- New `onDeployStart` callback on `DeployInput` — fired by Vercel adapter immediately after the create-deployment POST so the CLI can subscribe to logs in parallel with polling
- `--watch` CLI flag: when present and the adapter supports streaming, lines are piped to stderr in real time. On generic adapter, prints `--watch ignored — adapter "generic" does not support log streaming` and proceeds.

## Open question from spec — resolved

> *Do we need a streaming log API in DeployAdapter, or is --watch flag enough on the CLI side?*

Adapter-level. Symmetric with `status?` and `rollback?` from Phase 1. Testable in isolation. Composable for Phase 4 (auto-rollback wants log tails for the PR comment). Cost: one optional method.

## Spec & plan

- Spec: `docs/superpowers/specs/2026-04-30-vercel-adapter-phase2-design.md`
- Plan: `docs/superpowers/plans/2026-04-30-vercel-adapter-phase2.md`

## Out of scope

- Phase 3 (rollback) and Phase 4 (auto-rollback) — deferred per spec
- `claude-autopilot deploy logs <id>` subcommand — Phase 5
- Auth detection from CLI auth.json — Phase 6
- No `package.json` version bump (release tag gated on GH Actions billing).

## Test plan

- [x] 12+ new unit tests across `streamLogs` (NDJSON, partial chunks, malformed JSON, SSE prefix, abort, 401, 404 retry-then-fail, 404 retry-then-succeed, event filtering, onDeployStart firing) and CLI `--watch` (opt-in pipe, generic warning, off-by-default)
- [x] All Phase 1 tests still green (891 baseline → ~903)
- [x] `npx tsc --noEmit` clean for files touched
- [x] No new dependencies

EOF
)"
```

- [ ] **Step 4: Capture the PR URL**

Print: `gh pr view --json url --jq .url`

---

## Self-review

Spec coverage:
- ✅ `streamLogs(deployId, signal)` on adapter — Task 1 + Task 3
- ✅ Vercel adapter SSE/NDJSON impl with `?builds=1` — Task 3
- ✅ Generic adapter declares "no streaming" cleanly — Task 1 (omit method) + Task 6 (CLI warning verifies)
- ✅ `--watch` flag wires to streamLogs and pipes stderr — Task 6
- ✅ Tests for: mocked stream, abort, error responses, generic no-op, --watch flag — Tasks 3, 4, 5, 6
- ✅ Phase 3/4 deferred — explicit in spec + PR body

Placeholder scan: no TBD/TODO/etc. All code blocks are concrete.

Type consistency: `streamLogs` signature uses `DeployStreamLogsInput` and `DeployLogLine` consistently across types.ts, vercel.ts, and tests. `onDeployStart` callback typed identically in types.ts and CLI consumer. `adapterFactory` in `RunDeployOptions` returns the same `DeployAdapter` interface used by the production factory — single source of truth.

Method names: `streamLogs` (not `streamLog`, not `logs`, not `tail`) used uniformly. `onDeployStart` (not `onStart`, not `onDeploymentStart`) uniform.

No issues found. Plan ready.

---

## Execution

**Subagent-Driven mode** — autopilot dispatches a fresh subagent per task. Tasks 1-7 are tightly scoped and self-contained. Task 8 is the integration point.
