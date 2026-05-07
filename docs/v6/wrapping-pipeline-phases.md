# Wrapping Pipeline Phases — v6.0.x Recipe

**Audience:** maintainers wiring v5.x pipeline phases through `runPhase` one PR at a time.

**Status as of v6.0.9 — ALL 10 PHASES WRAPPED:** `scan` (v6.0.1), `costs` and `fix` (v6.0.2), `brainstorm` and `spec` (v6.0.3), `plan` and `review` (v6.0.4), `validate` (v6.0.5), `implement` (v6.0.7), `migrate` (v6.0.8 — first side-effecting wrap), `pr` (v6.0.9 — second side-effecting wrap). v6.0.6 extracted the lifecycle boilerplate into `runPhaseWithLifecycle` — the recipe below points at the helper. **v6.0.x is feature-complete.** This recipe stays in tree as a reference for future verbs that want to opt into the engine; the v6.0.x checklist itself is closed.

---

## Why one phase per PR

`runPhase` is a thin idempotency / event / snapshot layer over your existing phase body. The behavior change per phase is small in isolation but compounds across the pipeline (events.ndjson grows, state.json snapshots get bigger, idempotency gates start firing, …). Wrapping ten phases in one PR makes any regression hard to attribute. The recipe below ships the same shape for every phase so the diff stays mechanical.

## The phases that still need wrapping

Tracked in `docs/specs/v6-run-state-engine.md` "Idempotency rules + external operation ledger" plus `docs/v6/migration-guide.md` "Idempotency + replay rules":

| Phase | `idempotent` | `hasSideEffects` | externalRef kinds | Status |
|---|---|---|---|---|
| `brainstorm` | yes (v6.0.3 — see deviation note) | no | (none in v6.0.3; `spec-file` if/when the CLI verb grows a real LLM body) | **WRAPPED in v6.0.3** |
| `spec` | yes (v6.0.3 — see deviation note) | no | (none in v6.0.3; `spec-file` if/when the CLI verb grows a real LLM body) | **WRAPPED in v6.0.3** |
| `implement` | yes (v6.0.7 — see deviation note) | no (v6.0.7 — see deviation note) | (none in v6.0.7; `git-remote-push` if/when the CLI verb inlines the implement loop) | **WRAPPED in v6.0.7** |
| `migrate` | no (v6.0.8) | yes (v6.0.8) | `migration-version` (per env, scoped `<env>:<name>`) | **WRAPPED in v6.0.8** |
| `validate` | yes (v6.0.5) | no (v6.0.5) | (none in v6.0.5 — see deviation note) | **WRAPPED in v6.0.5** |
| `pr` | no (v6.0.9) | yes (v6.0.9) | `github-pr` (v6.0.9) | **WRAPPED in v6.0.9** |
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

> **Note for `migrate` (v6.0.8).** First side-effecting phase to land
> under the helper. Declares `idempotent: false, hasSideEffects: true,
> externalRefs: migration-version (scoped <env>:<name>)` — matches the
> spec table exactly. Why `idempotent: false` even though the underlying
> Delegance migrate skill is ledger-guarded against double-apply: at the
> *engine semantics* layer, `idempotent: true` means "re-running the
> phase against the same input produces equivalent output." A dispatch
> invocation that previously applied N migrations on attempt 1 and
> applies 0 on attempt 2 (everything already in the ledger) DOES produce
> different output (different `appliedMigrations` list, different
> `status`). The spec's `idempotent: false` is correct. Each applied
> migration emits `ctx.emitExternalRef({ kind: 'migration-version', id:
> '<env>:<migration_name>' })` so Phase 6's resume gate can read back
> the live ledger and decide skip-already-applied vs retry vs needs-
> human. The `<env>:` prefix scopes the ref by target environment so
> multi-env pipelines (dev → qa → prod) can disambiguate the same
> migration across targets. See `src/cli/migrate.ts` top-of-file
> rationale for the per-phase declaration; the wrap delegates to
> `src/core/migrate/dispatcher.ts` (unchanged) for the actual stack.md
> resolution / handshake / policy / execute / audit-log flow.

> **Deviation note for `validate` (v6.0.5).** The spec table at line 161 of `docs/specs/v6-run-state-engine.md` lists `validate` with `idempotent: yes, hasSideEffects: no, externalRefs: sarif-artifact`. The v6.0.5 wrap matches the `idempotent: true, hasSideEffects: false` declaration but does **not** plumb a `sarif-artifact` externalRef. The reasoning: the v6.0.5 `validate` CLI verb is an engine-wrap shell pointing at the Claude Code `/validate` skill — the verb itself does not emit a SARIF artifact. SARIF emission lives in `claude-autopilot run --format sarif --output <path>` (a separate verb). The `sarif-artifact` reference is local-only file output (no remote upload), so the engine doesn't need a readback rule for it on resume — `idempotent: true` covers replay safety. If a future PR adds SARIF emission directly to this verb (or moves the `--format sarif` flag here), the wrap can add a `ctx.emitExternalRef({ kind: 'sarif-artifact', id: '<path>', observedAt: ... })` call after the file write lands. Until then, no ledger entry is needed because there's nothing to read back from.

> **Deviation note for `implement` (v6.0.7).** The spec table at line 159 of `docs/specs/v6-run-state-engine.md` lists `implement` with `idempotent: partial, hasSideEffects: yes, externalRefs: git-remote-push`. The v6.0.7 wrap declares `idempotent: true, hasSideEffects: false` and does **not** plumb a `git-remote-push` externalRef. The reasoning: the v6.0.7 `implement` CLI verb is an engine-wrap shell pointing at the Claude Code `claude-autopilot` skill — the verb itself does not write code, run tests, commit, or push to a remote. All of that work lives in the skill (and its delegates: `subagent-driven-development`, `commit-push-pr`, `using-git-worktrees`). The CLI verb's only side effect is writing the local `.guardrail-cache/implement/<ts>-implement.md` log stub, which the engine treats as overwrite-style (same precedent as `.guardrail-cache/validate/`, `.guardrail-cache/plans/`, `.guardrail-cache/reviews/`). If a future PR inlines the implement loop into the CLI verb (writes code, runs tests, commits, pushes), the declarations flip to `idempotent: false, hasSideEffects: true` and the wrap will need to call `ctx.emitExternalRef({ kind: 'git-remote-push', id: '<commit-sha>', observedAt: ... })` after each successful push. The helper signature does not need to grow for that — `phase.run` already receives `ctx`, and the underlying `runPhase()` records externalRefs unchanged.

> **Note for `pr` (v6.0.9).** The wrap MATCHES the spec table (`idempotent: no, hasSideEffects: yes, externalRefs: github-pr`) — no deviation. `pr` is the first genuinely side-effecting verb wrapped in v6.0.x. The verb's phase body emits a `github-pr` externalRef BEFORE delegating to the inner `runCommand` so a crash mid-pipeline still leaves a breadcrumb pointing at the PR (the engine path's Phase 6 resume logic can `gh pr view <id>` to confirm the PR is still open before deciding whether a replay is safe). A `github-comment` externalRef per posted comment is a candidate follow-up (requires plumbing the post-comment URL out of `runCommand`, currently only logged — deferred to a follow-up PR). For v6.0.9 the `github-pr` ref is sufficient. The wrap adds two test seams (`__testPrMeta` to short-circuit `gh pr view`, `__testRunCommand` to stub the inner pipeline) so the smoke test exercises the engine lifecycle without `gh` or a real review pipeline.

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

### 3. Wire the lifecycle via `runPhaseWithLifecycle`

**v6.0.6+:** the lifecycle scaffolding (`createRun → runPhase → run.complete + state.json refresh + lock release`) lives in a single helper. Callers no longer hand-roll the engine-on/off branch:

```ts
import { type RunPhase } from '../core/run-state/phase-runner.ts';
import { runPhaseWithLifecycle } from '../core/run-state/run-phase-with-lifecycle.ts';

export async function run<Verb>(opts: {
  // ... existing options ...
  cliEngine?: boolean;
  envEngine?: string;
}) {
  const config = await loadConfig(...);

  // ... preflight (file collection, key checks, adapter loading) ...

  const phase: RunPhase<MyPhaseInput, MyPhaseOutput> = { /* step 1 */ };

  let output: MyPhaseOutput;
  try {
    const result = await runPhaseWithLifecycle<MyPhaseInput, MyPhaseOutput>({
      cwd,
      phase,
      input,
      config,
      cliEngine: opts.cliEngine,
      envEngine: opts.envEngine,
      // Engine-off escape hatch — the helper does NOT call phase.run for
      // you on engine-off, so callers have full control over the legacy
      // path. Most verbs just delegate to the same async function the
      // phase body wraps:
      runEngineOff: () => executeMyPhase(input),
    });
    output = result.output;
  } catch {
    // Helper already printed the legacy [<phase>] engine: phase failed
    // banner + emitted run.complete failed + refreshed state.json +
    // released the lock. Surface the legacy non-zero exit.
    return 1;
  }

  // Existing rendering / exit-code logic against `output`.
}
```

What the helper handles for you:

- Engine resolution (CLI > env > config > default), including the
  `run.warning` for invalid env values
- `createRun` for engine-on; calls `runEngineOff()` for engine-off
- `runPhase` invocation
- `run.complete` event (`status: 'success'` with `totalCostUSD` extracted
  from `output.costUSD` when the phase exposes one, else 0; or
  `status: 'failed'` on throw)
- `state.json` refresh from replayed events
- Best-effort lock release in `finally`
- The legacy `[<phase>] engine: phase failed — <msg>` + `inspect:` hint
  to stderr on failure, then re-throws so the caller can `return 1`

What the helper does NOT do:

- Print success banners — rendering stays in the caller
- Loaded-config plumbing — caller passes the config in
- ExternalRefs — those happen via `ctx.emitExternalRef()` from inside
  `phase.run`, which the underlying `runPhase()` handles unchanged

**Pre-v6.0.6 inline pattern** (still works — `runPhase` is unchanged):

If you have a reason to bypass the helper (sub-phase orchestration, custom run.complete totalCostUSD computation, etc.), the raw API is available — see `src/core/run-state/phase-runner.ts` for `runPhase` and `src/core/run-state/runs.ts` for `createRun`. The helper just bundles the common shape.

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

## Worked example: `scan` (v6.0.1, helper-migrated v6.0.6)

**Why scan first:**
- Single-shot verb (no sub-phases)
- Read-only — `idempotent: true, hasSideEffects: false` is uncontroversial
- Cleanly separable preflight (file collection) vs phase body (LLM call + finding processing)
- Already had a JSON-serializable result shape

**What `src/cli/scan.ts` looks like today (v6.0.6):**

1. `cliEngine` + `envEngine` + `__testReviewEngine` on `ScanCommandOptions`
2. `ScanInput` + `ScanOutput` (JSON-serializable shape of the phase boundary)
3. Phase body extracted into `executeScanPhase(input)` — pure function, no console output, no exit-code logic
4. `RunPhase<ScanInput, ScanOutput>` with `name: 'scan'`, `idempotent: true`, `hasSideEffects: false`, `run: executeScanPhase`
5. Single call to `runPhaseWithLifecycle({ cwd, phase, input, config, cliEngine, envEngine, runEngineOff: () => executeScanPhase(scanInput) })` wrapped in a try/catch that returns 1 on failure
6. Rendering (banner + finding tables + cost line) lives in `renderScanOutput(output, input)` so the engine path's idempotency isn't coupled to console output

**Banner deviation.** Scan prints a `engine: on (<source>)` line in its preflight banner (the only verb that does). The helper re-resolves engine state internally with identical precedence, so scan keeps a small inline `resolveEngineEnabled` call JUST for the banner — see the `engineBanner` block in `src/cli/scan.ts`. Other verbs don't print the source so they don't need this.

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
