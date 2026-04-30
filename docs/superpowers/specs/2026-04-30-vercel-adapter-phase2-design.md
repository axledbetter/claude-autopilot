# Vercel deploy adapter — Phase 2: log streaming (design)

**Status:** ready to implement
**Tracks:** v5.4 spec at `docs/specs/v5.4-vercel-adapter.md` (Phase 1 merged via PR #59)
**Estimated effort:** ~2h

---

## Goal

Add real-time build log streaming to the Vercel deploy adapter. When the user
runs `claude-autopilot deploy --watch`, build log lines from Vercel are piped
to stderr in real time as the deploy progresses.

## Open question from spec — resolved

> *Do we need a streaming log API in `DeployAdapter`, or is `--watch` flag
> enough on the CLI side?*

**Decision: add `streamLogs()` to the adapter as an optional method.**

Rationale:

1. **Symmetry.** Phase 1 established that platform-specific capabilities live
   on the adapter as optional methods (`status?`, `rollback?`). Log streaming
   is platform-specific by definition — putting it on the adapter keeps the
   abstraction honest.
2. **Testability.** A pure `streamLogs(input): AsyncIterable<DeployLogLine>`
   is unit-testable against a mocked stream. SSE parsing logic inside the CLI
   handler conflates concerns.
3. **Composability.** Phase 4 (auto-rollback) wants log tails attached to PR
   comments. The CLI `--watch` consumer is the *first* user, not the only one.

Cost: one optional method on the interface; generic adapter omits it.

---

## Architecture

```
DeployAdapter
  ├─ deploy()        (Phase 1)
  ├─ status?()       (Phase 1)
  ├─ rollback?()     (Phase 3)
  └─ streamLogs?()   (Phase 2 — NEW)
```

### New types (`src/adapters/deploy/types.ts`)

```ts
export interface DeployStreamLogsInput {
  deployId: string;
  signal?: AbortSignal;
}

export interface DeployLogLine {
  /** Timestamp from the platform if provided, else when received. */
  timestamp: number;
  /** Build phase or component (e.g. 'build', 'deploy'). Optional. */
  source?: string;
  /** 'info' | 'warn' | 'error' | 'stdout' | 'stderr' — adapter-defined. */
  level?: string;
  /** The log text itself, no trailing newline. */
  text: string;
}

export interface DeployAdapter {
  // ... existing
  streamLogs?(input: DeployStreamLogsInput): AsyncIterable<DeployLogLine>;
}
```

Also add to `DeployInput` (forward-compat for `--watch` wiring):

```ts
export interface DeployInput {
  // ... existing
  /** Fired exactly once with the platform-native deploy ID as soon as it's
   *  known. Adapters that obtain the ID synchronously (Vercel) call this
   *  immediately after the create-deployment POST resolves. Adapters that
   *  never get a discrete ID (generic) do not call it. */
  onDeployStart?: (deployId: string) => void;
}
```

### Vercel implementation

`streamLogs(input)` is an `async function*` (async generator):

1. `fetch`es `GET /v2/deployments/<id>/events?builds=1&follow=1` with
   `Accept: text/event-stream`, propagating `signal` and `teamId` query when
   the team is configured.
2. Reads response body via `response.body!.getReader()` (web streams).
3. Decodes UTF-8 chunks. Splits on `\n` for line-delimited events. Holds a
   buffer for partial lines spanning chunk boundaries.
4. Parses each non-empty line as JSON. Vercel's events endpoint with
   `?builds=1` returns NDJSON: `{type, payload, created, ...}`. Maps events
   where `type === 'stdout' | 'stderr'` into `DeployLogLine`. Ignores
   `type === 'state' | 'complete'` etc. — those are deploy-state events,
   not log content.
5. **SSE fallback.** Some Vercel responses prefix lines with `data: ` (classic
   SSE). Parser strips that prefix when present, then JSON-parses the rest.
   Empty lines and `event:` / `id:` / `:` (heartbeat) lines are skipped.
6. **Malformed JSON.** A line that fails to parse is skipped silently — we
   don't crash the stream over a single bad event.
7. **Abort.** When the caller's `signal` aborts, the underlying fetch throws
   `AbortError`. We re-throw so the consumer's `for await` exits cleanly.
8. **HTTP errors.** Reuse `assertOkOrThrow` from Phase 1: 401/403 → `auth`,
   404 → `invalid_config`, 5xx → `adapter_bug`, all wrapped in
   `GuardrailError`.
9. **404 race.** Right after the deploy POST resolves, the events endpoint
   may briefly 404 because the deploy hasn't propagated. Retry the initial
   GET up to 3 times with 500ms backoff before throwing.

### Generic adapter

Does not implement `streamLogs`. The optional method is the cleanest "not
supported" signal — callers do `adapter.streamLogs?.(...)` and check for
`undefined`. The CLI handler prints:

```
[deploy] --watch ignored — adapter "generic" does not support log streaming
```

### CLI wiring

1. Add `--watch` boolean flag in `src/cli/index.ts` deploy subcommand
   (parsed via existing `boolFlag('watch')`).
2. Pass `watch: boolean` into `runDeploy()`.
3. In `runDeploy`, when `watch === true`:
   - If `adapter.streamLogs` is defined: build an `AbortController` for the
     stream. Pass an `onDeployStart` callback into `deploy()` that, when
     called, fires `streamLogs({ deployId, signal: controller.signal })` in
     the background and pipes each line to `process.stderr` (formatted as
     `[deploy] <text>` or just the raw text for cleaner piping).
   - If `adapter.streamLogs` is undefined: print the unsupported warning,
     proceed without streaming.
   - After `deploy()` resolves (any status), `controller.abort()` to stop
     the stream cleanly.
4. The background stream errors are caught and logged to stderr but do NOT
   change the exit code — log streaming is a non-critical observability
   feature.

### Vercel `deploy()` change for Phase 2

Phase 1's `deploy()` POSTs + polls atomically. Phase 2 adds *one line*: after
the POST returns the deployment id but before polling starts, fire
`input.onDeployStart?.(created.id)`. No other behavior changes. Generic's
`deploy()` is untouched.

---

## Tests

Target: 12+ new tests. Test count 891 → ~903.

### `tests/deploy-vercel.test.ts` additions (~8)

1. `streamLogs() yields DeployLogLines parsed from a mocked NDJSON stream`
2. `streamLogs() filters non-log event types (state, complete) so only stdout/stderr surface`
3. `streamLogs() handles partial chunks across reads (a line split mid-event)`
4. `streamLogs() tolerates malformed JSON by skipping the bad line`
5. `streamLogs() honors AbortSignal — aborts the underlying fetch and exits the iterator`
6. `streamLogs() throws GuardrailError(code:auth) on 401`
7. `streamLogs() throws GuardrailError(code:invalid_config) on 404 after retries exhausted`
8. `streamLogs() retries 404 up to 3 times with backoff (race-after-create)`
9. `streamLogs() handles SSE-style 'data: {...}' prefix in addition to raw NDJSON`
10. `deploy() fires onDeployStart with the new id immediately after create POST`

### `tests/deploy-cli.test.ts` additions (~3)

1. `--watch flag opts in: streamLogs is invoked and lines reach stderr`
2. `--watch on generic adapter prints unsupported warning, deploy still succeeds`
3. `--watch with adapter abort cancels the stream and the deploy itself cleanly`

### `tests/deploy-types.test.ts` additions (~2)

1. `DeployStreamLogsInput and DeployLogLine are exported`
2. `streamLogs is optional on DeployAdapter (omitting compiles)`

---

## Risk register

| Risk | Mitigation |
|---|---|
| Vercel events endpoint returns SSE not NDJSON | Parser accepts both — strip `data: ` prefix when present |
| Web `ReadableStream` API differs in Node | Native fetch in Node 18+ returns a standard web ReadableStream; tests mock the same shape |
| 404 race after POST | Retry initial GET 3x with 500ms backoff inside `streamLogs` |
| `--watch` on generic blows up | Optional-method check + warning, no-op for generic |
| Stream error crashes the deploy | Stream errors caught and logged, do not affect exit code |

---

## Out of scope (deferred to later phases)

- Phase 3: rollback (`POST /v13/deployments/<id>/promote`)
- Phase 4: auto-rollback wired to `rollbackOn: [healthCheckFailure]`
- Phase 5: `deploy logs <id>` and `deploy status <id>` CLI subcommands
- Phase 6: auth detection from `~/.local/share/com.vercel.cli/auth.json`
- Persisting logs to a file — stderr-only
- Colorizing log output — lines stream as-is

---

## Acceptance criteria

- [ ] `DeployAdapter.streamLogs?` exists and is exported
- [ ] `VercelDeployAdapter.streamLogs` parses Vercel NDJSON (and SSE `data:`) events
- [ ] Generic adapter omits `streamLogs` cleanly (no throw)
- [ ] `--watch` flag wired in CLI, pipes lines to stderr in real time
- [ ] `--watch` on generic adapter prints unsupported warning and continues
- [ ] All Phase 1 behavior unchanged except: `Vercel.deploy()` fires
      `input.onDeployStart?.(deploymentId)` once after the create POST
      resolves. Existing Phase 1 tests stay green (callback is optional).
- [ ] 12+ new tests covering NDJSON/SSE parsing, abort, error paths
      (401/404/5xx), partial chunks, malformed JSON, post-create 404
      retries, generic-adapter no-op, `onDeployStart` firing
- [ ] `tsc --noEmit` clean
- [ ] No package.json version bump (5.2.3 stays — release tag is gated on GH Actions billing)
