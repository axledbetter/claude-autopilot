# Wrapping Pipeline Phases — v6.0.x Recipe

**Audience:** maintainers wiring v5.x pipeline phases through `runPhase` one PR at a time.

**Status as of v6.0.4:** SEVEN phases wrapped — `scan` (v6.0.1), `costs` and `fix` (v6.0.2), `brainstorm` and `spec` (v6.0.3), plus `plan` and `review` (v6.0.4). Subsequent v6.0.x point releases wrap the rest using this recipe; aim for one or two phases per PR so blast radius stays small and bugbot can catch regressions phase-by-phase.

---

## Why one phase per PR

`runPhase` is a thin idempotency / event / snapshot layer over your existing phase body. The behavior change per phase is small in isolation but compounds across the pipeline (events.ndjson grows, state.json snapshots get bigger, idempotency gates start firing, …). Wrapping ten phases in one PR makes any regression hard to attribute. The recipe below ships the same shape for every phase so the diff stays mechanical.

## The phases that still need wrapping

Tracked in `docs/specs/v6-run-state-engine.md` "Idempotency rules + external operation ledger" plus `docs/v6/migration-guide.md` "Idempotency + replay rules":

| Phase | `idempotent` | `hasSideEffects` | externalRef kinds | Status |
|---|---|---|---|---|
| `brainstorm` | yes (v6.0.3 — see deviation note) | no | (none in v6.0.3; `spec-file` if/when the CLI verb grows a real LLM body) | **WRAPPED in v6.0.3** |
| `spec` | yes (v6.0.3 — see deviation note) | no | (none in v6.0.3; `spec-file` if/when the CLI verb grows a real LLM body) | **WRAPPED in v6.0.3** |
| `implement` | partial | yes | `git-remote-push` | NOT WRAPPED |
| `migrate` | no | yes | `migration-version` (per env) | NOT WRAPPED |
| `validate` | yes | no | `sarif-artifact` | NOT WRAPPED |
| `pr` | no | yes | `github-pr` | NOT WRAPPED |
| `scan` | yes | no | (none in v6.0.1) | **WRAPPED in v6.0.1 (worked example below)** |
| `fix` | yes (v6.0.2) | no (v6.0.2) | (none in v6.0.2; `git-remote-push` if/when `--push` is added) | **WRAPPED in v6.0.2** |
| `costs` | yes | no | (none) | **WRAPPED in v6.0.2** |
| `plan` | yes (v6.0.4) | no (v6.0.4) | (none in v6.0.4; `plan-file` if/when the verb writes durable plan artifacts that need replay) | **WRAPPED in v6.0.4** |
| `review` | yes (v6.0.4) | no (v6.0.4) | (none in v6.0.4 — see deviation note) | **WRAPPED in v6.0.4** |

> **Deviation note for `brainstorm` and `spec` (v6.0.3).** The
> [v6 spec table](../specs/v6-run-state-engine.md) declares both phases
> `idempotent: no` because the LLM dialogue produces new content each time. The
> wraps in v6.0.3 declare `idempotent: true` because the CLI verbs themselves
> are advisory pointers at the Claude Code skill — they don't run the LLM, they
> print a static message and exit. With no LLM call and no externalRefs, "safe
> to retry" trivially holds; the engine's idempotency check is "safe to replay,"
> not "produces byte-identical output." Once the CLI verbs grow a real LLM body
> (a future v6.x lift), the declaration may flip to `idempotent: false` and an
> `externalRefs: [{ kind: 'spec-file', id: '<slug>' }]` ledger entry will land
> on every successful run. See `src/cli/brainstorm.ts` and `src/cli/spec.ts`
> top-of-file comments for the per-phase rationale.

> **Deviation note for `review` (v6.0.4).** The spec table elsewhere in this repo (`docs/specs/v6-run-state-engine.md`) lists `review` with `idempotent: yes, hasSideEffects: no, externalRefs: review-comments`, which assumes the verb posts review comments to GitHub PRs. The v6.0.4 `review` CLI verb does **not** post anywhere — PR-side comment posting lives in `claude-autopilot pr --inline-comments` / `--post-comments` (a separate verb). The wrapped behavior is local-file-only (writes a review log stub under `.guardrail-cache/reviews/`), so `hasSideEffects: false` is correct for v6.0.4. If a future PR adds platform-side comment posting to this verb, both declarations will flip and a `review-comments` externalRef readback rule will need to land in the recipe.

Read-only phases (`scan`, `validate`, `review`, `costs`, `plan`) are the safest first wraps because they have no provider-side side effects and the engine's idempotency rules collapse to "retry freely." Side-effecting phases (`pr`, `migrate`, `implement`, `fix`, `deploy`) need careful externalRef plumbing; wrap them last.

---

## The recipe (six steps)

### 1. Define `RunPhase<I, O>`

In the file that owns the phase verb (e.g. `src/cli/<verb>.ts`):

```ts
import { runPhase, type RunPhase } from '../core/run-state/phase-runner.ts';

interface MyPhaseInput {
  // Everything the phase body needs that's been resolved by the outer
  // scope. Must be JSON-serializable (or you accept that idempotent
  // skip-already-applied won't restore it cleanly).
}

interface MyPhaseOutput {
  // What the verb returns. JSON-serializable so runPhase can persist it
  // as `result` on phases/<name>.json. Used by Phase 6 skip-already-applied.
}

const phase: RunPhase<MyPhaseInput, MyPhaseOutput> = {
  name: '<verb>',                  // matches the CLI verb. Used in events
                                   // and `phases/<name>.json` filename.
  idempotent: true,                // re-running the phase against the same
                                   // input is safe and produces equivalent
                                   // output. See the table above.
  hasSideEffects: false,           // true → side-effecting (PR comment,
                                   // git push, deploy). The engine consults
                                   // externalRefs + provider read-back
                                   // before retrying side-effecting phases.
  run: async (input, ctx) => {
    // The existing phase body. Use ctx.emitCost / ctx.emitExternalRef when
    // the phase spends LLM tokens or interacts with a provider.
    return { /* output */ };
  },
};
```

### 2. Decide `idempotent` and `hasSideEffects`

Use the table above. When in doubt:

- **idempotent: true** — phase output depends only on its input + project state, and re-running gives the same answer. Read-only verbs (`scan`, `validate`, `review`, `costs`) are always idempotent.
- **hasSideEffects: true** — phase calls a provider that mutates external state (post a PR comment, push to git, run a migration, deploy). The engine refuses to replay these without `--force-replay` when prior `externalRefs` exist.

If a phase is "partial" (`implement`, `fix`, `bugbot`), set `idempotent: false, hasSideEffects: true` and add an `onResume` handler that consults the persisted `externalRefs`.

### 3. Conditional `runPhase` route

Wrap the existing entry point so the engine-off path is byte-for-byte unchanged:

```ts
import { resolveEngineEnabled } from '../core/run-state/resolve-engine.ts';
import { createRun } from '../core/run-state/runs.ts';
import { appendEvent, replayState } from '../core/run-state/events.ts';
import { writeStateSnapshot } from '../core/run-state/state.ts';

export async function run<Verb>(opts: {
  // ... existing options ...
  cliEngine?: boolean;
  envEngine?: string;
}) {
  const config = await loadConfig(...);
  const engineResolved = resolveEngineEnabled({
    ...(opts.cliEngine !== undefined ? { cliEngine: opts.cliEngine } : {}),
    ...(opts.envEngine !== undefined ? { envValue: opts.envEngine } : {}),
    ...(typeof config.engine?.enabled === 'boolean'
      ? { configEnabled: config.engine.enabled } : {}),
  });

  // ... preflight (file collection, key checks, adapter loading) ...

  const phase: RunPhase<MyPhaseInput, MyPhaseOutput> = { /* step 1 */ };
  let output: MyPhaseOutput;
  if (engineResolved.enabled) {
    const created = await createRun({
      cwd, phases: ['<verb>'],
      config: { engine: { enabled: true, source: engineResolved.source } },
    });
    if (engineResolved.invalidEnvValue !== undefined) {
      appendEvent(created.runDir, {
        event: 'run.warning',
        message: `invalid CLAUDE_AUTOPILOT_ENGINE=${JSON.stringify(engineResolved.invalidEnvValue)} ignored`,
        details: { resolution: engineResolved },
      }, { writerId: created.lock.writerId, runId: created.runId });
    }
    const startedAt = Date.now();
    try {
      output = await runPhase(phase, input, {
        runDir: created.runDir,
        runId: created.runId,
        writerId: created.lock.writerId,
        phaseIdx: 0,
      });
      appendEvent(created.runDir, {
        event: 'run.complete',
        status: 'success',
        totalCostUSD: output.costUSD ?? 0,
        durationMs: Date.now() - startedAt,
      }, { writerId: created.lock.writerId, runId: created.runId });
      writeStateSnapshot(created.runDir, replayState(created.runDir));
    } catch (err) {
      appendEvent(created.runDir, {
        event: 'run.complete',
        status: 'failed',
        totalCostUSD: 0,
        durationMs: Date.now() - startedAt,
      }, { writerId: created.lock.writerId, runId: created.runId });
      writeStateSnapshot(created.runDir, replayState(created.runDir));
      await created.lock.release();
      throw err;
    } finally {
      await created.lock.release().catch(() => { /* ignore */ });
    }
  } else {
    output = await phase.run(input, /* synthetic ctx — see below */);
  }

  // Existing rendering / exit-code logic against `output`.
}
```

### 4. Add `--engine` / `--no-engine` plumbing in `src/cli/index.ts`

The dispatcher already has `parseEngineCliFlag()` (added in v6.0.1). Pass through:

```ts
case '<verb>': {
  // ... existing flag parsing ...
  const cliEngine = parseEngineCliFlag();
  const code = await runUnderJsonMode(
    { command: '<verb>', active: json },
    () => run<Verb>({
      // ... existing options ...
      ...(cliEngine !== undefined ? { cliEngine } : {}),
      envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
    }),
  );
  process.exit(code);
}
```

### 5. Update help text

In `src/cli/help-text.ts`, add `--engine` / `--no-engine` to the per-verb Options block:

```
<verb>: `Options (<verb>):
  ...
  --engine             Run under the v6 Run State Engine (writes .guardrail-cache/runs/<ulid>/)
  --no-engine          Force the legacy stateless code path (overrides config / env)`,
```

The global flags block already advertises both. Adding them to the per-verb block makes `claude-autopilot help <verb>` complete on its own.

### 6. Add a smoke test

`tests/cli/<verb>-engine-smoke.test.ts`. Pattern: drive the verb with `cliEngine: true`, inject a fake provider via the `__test*` seam (or use the existing fakes in your verb's test file), then assert:

- `state.json` exists with `status: 'success'`, the right phase name + `idempotent` / `hasSideEffects` flags, `attempts: 1`
- `events.ndjson` includes `run.start`, `phase.start`, `phase.success`, `run.complete` in order
- Without `--engine`, no `.guardrail-cache/runs/` directory is created

The smoke test in `tests/cli/scan-engine-smoke.test.ts` is the canonical template — copy it.

---

## Worked example: `scan` (v6.0.1)

**Why scan first:**
- Single-shot verb (no sub-phases)
- Read-only — `idempotent: true, hasSideEffects: false` is uncontroversial
- Cleanly separable preflight (file collection) vs phase body (LLM call + finding processing)
- Already had a JSON-serializable result shape

**What changed in `src/cli/scan.ts`:**

1. Added `cliEngine` + `envEngine` + `__testReviewEngine` to `ScanCommandOptions`
2. Resolved engine via `resolveEngineEnabled` after config load
3. Defined `ScanInput` + `ScanOutput` (JSON-serializable shape of the phase boundary)
4. Extracted the LLM-call-and-processing portion into `executeScanPhase(input)` — pure function, no console output, no exit-code logic
5. Defined `RunPhase<ScanInput, ScanOutput>` with `name: 'scan'`, `idempotent: true`, `hasSideEffects: false`, `run: executeScanPhase`
6. Added a `if (engineResolved.enabled)` branch that does `createRun → runPhase → run.complete` plus the state.json refresh; the else branch calls `executeScanPhase` directly
7. Extracted the rendering (banner + finding tables + cost line) into `renderScanOutput(output, input)` so the engine path's idempotency isn't coupled to console output

**What did NOT change:**
- The engine-off code path is byte-for-byte unchanged. No run dir, no events, no lifecycle work, identical stdout / stderr / exit code from v5.x.
- The CLI flag set (apart from adding `--engine` / `--no-engine`).
- The `--json` envelope shape.
- The findings cache, cost log, ignore rules — all writes happen inside the phase body, untouched.

**Smoke test:** `tests/cli/scan-engine-smoke.test.ts`. 5 cases, ~250 lines, runs in <2s.

---

## Idempotency rules — quick reference

The full matrix is in [`docs/v6/migration-guide.md`](./migration-guide.md#idempotency--replay-rules). Decision tree:

```
prior phase.success exists for this phaseIdx?
├── no  → run normally
├── yes
│   ├── idempotent: true            → retry (just re-run)
│   ├── hasSideEffects: false       → retry
│   ├── hasSideEffects: true
│   │   ├── --force-replay          → emit replay.override + retry
│   │   ├── readback says applied   → skip-already-applied + return prior result
│   │   ├── readback says not-applied → retry
│   │   └── readback unknown        → throw needs-human (CI: exit 78)
```

`runPhase` does this gating automatically based on the `RunPhase` flags + persisted `externalRefs`. Your phase body just emits via `ctx.emitExternalRef(...)` whenever it lands a side-effecting operation.

---

## Checklist for v6.0.x point releases

Use this when you open a PR wrapping a phase:

- [ ] `RunPhase<I, O>` defined with `name`, `idempotent`, `hasSideEffects` (per the table)
- [ ] `I` and `O` are JSON-serializable
- [ ] Phase body extracted into a pure async function (no console output, no exit codes, no `process.exit`)
- [ ] Side-effecting work calls `ctx.emitExternalRef({ kind, id, observedAt })` after the operation lands
- [ ] LLM cost reported via `ctx.emitCost({ provider, inputTokens, outputTokens, costUSD })`
- [ ] CLI dispatcher passes `cliEngine` + `envEngine` through
- [ ] Help text updated (per-verb Options block)
- [ ] Smoke test asserts state.json + events.ndjson shape
- [ ] Engine-off path is byte-for-byte unchanged (existing tests still pass without modification)
- [ ] `npm test` clean — no test count regression
- [ ] `npx tsc --noEmit` clean
- [ ] `CHANGELOG.md` `vX.Y.Z` section cites the PR + which phase was wrapped
- [ ] `docs/specs/v6-run-state-engine.md` reconciliation block updated
- [ ] `docs/v6/migration-guide.md` "what works today" list updated to include the new phase

When all items check, the PR is ready for review. Wait for bugbot to triage before merge.

---

## Multi-phase pipelines (future)

The single-phase wrapping above is the v6.0.x baseline. Multi-phase pipelines (e.g. `autopilot` → `brainstorm → spec → plan → implement → migrate → validate → pr → review`) build on it:

```ts
const created = await createRun({
  cwd, phases: ['brainstorm', 'spec', 'plan', /* ... */],
});
const brainstormOut = await runPhase(brainstormPhase, input, {
  runDir: created.runDir, runId: created.runId,
  writerId: created.lock.writerId, phaseIdx: 0,
});
const specOut = await runPhase(specPhase, brainstormOut, { /* phaseIdx: 1 */ });
// ... etc ...
appendEvent(created.runDir, { event: 'run.complete', status: 'success', /* ... */ });
```

That's a separate v6.x lift and not in scope for v6.0.x phase-wrapping. v6.0.x just wraps each phase as a standalone single-phase run; orchestrating them under one runId comes with the autopilot orchestrator wrap (probably v6.2 / v6.3).

---

## Where to read further

- **The wrap pattern in code:** `src/cli/scan.ts` (lines around `RunPhase<ScanInput, ScanOutput>`)
- **The smoke test template:** `tests/cli/scan-engine-smoke.test.ts`
- **The runner contract:** `src/core/run-state/phase-runner.ts` (top of file)
- **Idempotency matrix:** `docs/v6/migration-guide.md#idempotency--replay-rules`
- **Spec:** `docs/specs/v6-run-state-engine.md` "Phase contract", "Run lifecycle"

---

## Note on interactive verbs

The recipe above describes phase bodies as pure functions with no console output and no exit-code logic — that's the right default for read-only / batch verbs (`scan`, `costs`, `validate`, `review`). Some verbs are intrinsically interactive: `fix` shows the user a per-finding diff and reads a [y/n/q] decision via `readline`. For those, **emitting console output and using readline inside the phase body is intentional and accepted.** The summary line + exit-code logic still lives in a separate render function so the engine path's idempotency isn't coupled to the final stdout shape, but the apply loop itself stays in the phase body. See `src/cli/fix.ts`'s `executeFixPhase` for the canonical example. The same precedent already exists in scan (the LLM call lives inside `executeScanPhase`, not in the outer scope).
