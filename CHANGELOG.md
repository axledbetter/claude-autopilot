## Unreleased

- v5.6 Phase 7 (docs reconciliation) — pending.

## 6.1.0 — Default flip: engine on by default + `--no-engine` deprecated (2026-05-07)

**Headline.** The Run State Engine is now ON by default. Bare
`claude-autopilot <verb>` invocations create a `.guardrail-cache/runs/<ulid>/`
directory, emit typed NDJSON events on stderr, apply budget gates if
`budgets:` is configured, and write a state snapshot — without any opt-in
config. v6.0 shipped the engine OFF behind an explicit `engine.enabled: true`
opt-in to give users control during a stabilization window; v6.1 closes
that window.

**Motivation — v6.0 stabilization criteria met.**
- 10 of 10 pipeline phases wrapped through `runPhaseWithLifecycle`
  (`scan` v6.0.1, `costs`/`fix` v6.0.2, `brainstorm`/`spec` v6.0.3,
  `plan`/`review` v6.0.4, `validate` v6.0.5, `implement` v6.0.7,
  `migrate` v6.0.8 — first side-effecting wrap with `migration-version`
  externalRefs, `pr` v6.0.9 — second side-effecting wrap with `github-pr`
  externalRefs).
- Lifecycle helper extracted (v6.0.6) so all 10 wraps share the same
  byte-for-byte engine-on / engine-off behavior.
- Side-effecting wraps proven (`migrate` + `pr`) — externalRef ledger
  + provider readback semantics exercised end-to-end.
- Live adapter cert suite green (Vercel + Fly + Render).
- `runs watch <id>` live cost/budget meter shipped (this release's
  `v6.1.0-pre` entry below) — the YC-demo moment for the events stream.
- `npm test` baseline: 1469 → 1492 (+23 net new this release; all green).

**Deprecation.** `--no-engine`, `CLAUDE_AUTOPILOT_ENGINE=off|false|0|no`,
and `engine.enabled: false` continue to work as the legacy escape hatch
in v6.1.x. Each invocation that resolves to engine-off via one of those
explicit opt-outs now prints a single-line stderr deprecation notice:

```
[deprecation] --no-engine / engine.enabled: false will be removed in v7. Migrate to engine-on (default).
```

The notice fires only on user-driven opt-outs (`source: 'cli' | 'env' |
'config'`); the new (engine-on) default never trips it. **v7 removes
the escape hatch** — `engine.enabled: false` becomes a config validation
error and `--no-engine` / `CLAUDE_AUTOPILOT_ENGINE=off` are silently
ignored.

**Spec.** [`docs/specs/v6.1-default-flip.md`](docs/specs/v6.1-default-flip.md)
is the canonical reference for what flipped, why, and the v7 follow-up.

**Migration tips.**
- If your CI parses stderr as free-form text and relies on the v5.x
  shape, set `CLAUDE_AUTOPILOT_ENGINE=off` (or pass `--no-engine`)
  to pin the legacy behavior. You'll see the deprecation notice on
  every invocation until you remove it — that's expected.
- If you opt out via config (`engine.enabled: false`), the same notice
  fires on every invocation. Plan to remove that line before bumping
  to v7.
- Existing users on `engine.enabled: true` are no-op'd — your config
  still wins via the same precedence rules.
- See [`docs/v6/migration-guide.md#migrating-from-v60-to-v61`](docs/v6/migration-guide.md)
  for the full upgrade walkthrough.

**Test surface.**
- `tests/run-state/resolve-engine.test.ts` — flipped 4 default-related
  cases. New `v6.1 default-flip` describe block + `v6.1 deprecation
  warning` describe block covering the predicate, the emitter, the
  default `process.stderr` branch, and the `builtInDefault` override
  path.
- `tests/run-state/run-phase-with-lifecycle.test.ts` — added 4 new
  cases pinning engine-on as the new default + the deprecation banner
  firing on opt-out / staying silent on the new default.
- 9 engine-smoke tests (`brainstorm`, `costs`, `implement`, `migrate`,
  `plan`, `pr`, `review`, `spec`, `validate`) updated — the
  "engine off (default)" cases are now "engine on (v6.1 default)";
  the matching `cliEngine: false` cases stay as legacy-escape-hatch
  coverage.

**Files changed.**
- `src/core/run-state/resolve-engine.ts` — default constant
  `ENGINE_DEFAULT_V6_1 = true`; `ENGINE_DEFAULT_V6_0` kept as a
  deprecated alias pointing at the new value. New
  `emitEngineOffDeprecationWarning` helper + `shouldWarnEngineOffDeprecation`
  predicate + `ENGINE_OFF_DEPRECATION_MESSAGE` stable copy.
- `src/core/run-state/run-phase-with-lifecycle.ts` — wires the
  deprecation helper into the engine-off branch.
- `docs/v6/migration-guide.md` — new "Migrating from v6.0 to v6.1"
  section, updated precedence matrix, refreshed default-flip plan,
  relabeled "What changes" table.
- `README.md` — v6 section updated (engine on by default + v7 removal
  timeline).
- `package.json` — version `5.5.2` → `6.1.0`.

## v6.1.0-pre — `runs watch <id>` live cost meter (2026-05-07)

**The YC-demo moment.** v6.0.x hardened the events.ndjson stream across
all 10 wrapped phases; v6.1 makes that stream visible in real time.
`runs watch <runId>` tails events.ndjson via `fs.watchFile` (1s poll —
inotify/FSEvents are unreliable for tiny appends across our matrix) and
pretty-renders each event with a running cost/budget meter so a user
running `claude-autopilot autopilot ...` in one terminal can `runs watch`
in another and watch their $25 budget tick down while phases ship code.

**Demo transcript.** Live tail of a fixture run, ANSI-stripped:

```
* run 01HZK7P3D8Q9V00000000000AB
  phases: spec -> plan -> implement -> pr
  budget: $0.00 / $25.00 (0%)
[12:00:01] phase.start         spec
[12:00:42] phase.cost          spec           +$0.07  (in: 1.2k, out: 3.4k)  total: $0.07
[12:00:45] phase.success       spec           OK 44.2s
[12:00:46] phase.start         plan
[12:01:12] phase.cost          plan           +$0.21  (in: 4.1k, out: 8.2k)  total: $0.28
[12:01:15] phase.success       plan           OK 29.0s
[12:08:33] phase.externalRef   pr             -> github-pr#123
[12:08:34] run.complete        status=success  totalCostUSD=$4.20  duration=8m32s

done  run 01HZK7P3D8Q9V00000000000AB
  status=success  totalCostUSD=$4.20  duration=8m33s
```

**Modes.**

- `runs watch <id>` — live tail, exits on `run.complete` / Ctrl-C
- `runs watch <id> --since <seq>` — replay forward from a specific seq
  (resume after disconnect)
- `runs watch <id> --no-follow` — render snapshot once and exit (CI /
  scripting)
- `runs watch <id> --json` — emit raw NDJSON to stdout (one event per
  line) for piping to `jq` or external dashboards. ANSI suppressed.
- `runs watch <id> --no-color` — force ANSI off even on a TTY

**Pretty rendering.** Color thresholds on the budget bar — green <50%,
yellow 50-90%, red >90%. Per-event coloring: cyan for phase.start, yellow
for phase.cost, green for phase.success, red for phase.failed, magenta
for phase.externalRef + lock.takeover + replay.override, bold-green for
run.complete success, bold-red for run.complete failed/aborted. ANSI
auto-strips when stdout is not a TTY (CI), when `--no-color` or `--json`
is set, or when `NO_COLOR` env var is present.

**Pure renderer.** `src/cli/runs-watch-renderer.ts` is referentially
transparent — `renderEventLine(event, runningTotal, opts)` is the core
primitive, exported and 100% pure. Tests run as string-equality
assertions in <300ms.

**Engine modules untouched.** This is purely a consumer of the existing
event stream — no changes to `src/core/run-state/**`, no changes to the
10 wrapped phase verbs, no changes to `runPhaseWithLifecycle`.

**Tests.** +43 new tests:
- `tests/cli/runs-watch-renderer.test.ts` — 29 pure-renderer cases
  covering every event-line variant, the three budget-bar color
  thresholds, ANSI on/off symmetry, and the final-summary block
- `tests/cli/runs-watch.test.ts` — 14 verb-level cases covering
  `--no-follow` snapshot, `--since` replay, `--json` mode, run-not-found
  (exit 2), invalid-ULID, live tail picks up appended events,
  budget rendering with/without `BudgetConfig`, plural `budgets` config
  alias, ANSI behavior, and run-complete short-circuit on already-
  terminated runs

**CLI plumbing.** New sub-verb on the `runs` umbrella: `runs watch <id>`.
Help block surfaces `--since`, `--no-follow`, `--json`, `--no-color`
plus a behavior summary + exit-code key. Exit codes: 0 success / clean
exit, 1 invalid input or stream error, 2 not_found.

## v6.0.9 — wrap `pr` through `runPhaseWithLifecycle` (2026-05-06)

**First side-effecting phase wrapped.** v6.0.1 → v6.0.5 wrapped read-only
verbs (`scan`, `costs`, `fix`, `brainstorm`, `spec`, `plan`, `review`,
`validate`); v6.0.6 extracted the lifecycle helper. v6.0.9 wraps `pr` —
the first verb that mutates state on the platform of record (GitHub
issue comments + PR reviews). This proves the helper's `ctx.emitExternalRef`
plumbing for genuinely side-effecting phases without any helper-shape
changes.

**Declarations.** Match the v6 spec table exactly:

- `idempotent: false` — re-running posts a NEW PR review ID each time
  (`postReviewComments` dismisses prior + creates new). PR comment
  posting (`postPrComment`) is marker-deduped on the body but the
  underlying `gh` API call is still mutating.
- `hasSideEffects: true` — posts to GitHub via the `gh` CLI inside the
  inner `runCommand` invocation.
- `externalRefs: github-pr` — recorded BEFORE the inner `runCommand`
  runs so a crash mid-pipeline still leaves a breadcrumb pointing at
  the PR. The engine path's Phase 6 resume logic can `gh pr view <id>`
  to confirm the PR is still open before deciding whether a replay
  is safe.

**Engine-off byte-for-byte unchanged.** All `gh pr view` + `git fetch` +
`runCommand` behavior preserved. The wrap adds two test seams
(`__testPrMeta` to short-circuit PR metadata lookup, `__testRunCommand`
to stub the inner pipeline) so the smoke test exercises the engine
lifecycle without `gh` or a real review pipeline. Production callers
must not pass these — they're documented "test only" with a comment
mirroring scan / fix's `__testReviewEngine` precedent.

**CLI plumbing.** The `pr` dispatcher arm now threads `cliEngine` from
`parseEngineCliFlag()` and `envEngine` from
`process.env.CLAUDE_AUTOPILOT_ENGINE`, mirroring every other wrapped
verb. The per-verb help block (`claude-autopilot help pr`) gains
`--engine` / `--no-engine` lines plus a side-effects note (engine-on
records a `github-pr` externalRef; future replays gate on the spec's
"side-effect readback" rule). `GLOBAL_FLAGS_BLOCK` adds "v6.0.9: wired
for `pr`" to its breadcrumb list.

**Smoke test.** New `tests/cli/pr-engine-smoke.test.ts`, 6 cases:
- engine off (default): no run dir / no engine artifacts; runCommand
  still invoked
- engine off (`cliEngine: false`): no run dir
- engine on (`--engine`): state.json + events.ndjson + lifecycle in
  order (run.start → phase.start → phase.externalRef → phase.success
  → run.complete); externalRef recorded with kind=`github-pr`,
  id=`42`, provider=`github`; `idempotent: false, hasSideEffects: true`
  reflected on the phase
- env precedence (`CLAUDE_AUTOPILOT_ENGINE=on` without CLI flag)
- CLI override (`--no-engine` beats env on)
- runCommand returning 1 surfaces as verb exit 1 WITHOUT marking the
  engine phase as failed (pipeline result ≠ phase failure, same
  precedent as scan)

**Why no follow-up `github-comment` externalRef yet.** A potential
extension is to record one externalRef per posted comment / review
(`github-comment`). That requires plumbing the post-comment URL out
of `runCommand` (currently only logged) — deferred to a follow-up PR.
For v6.0.9 the `github-pr` ref is sufficient for the spec's readback
rule: a Phase 6 resume can verify the PR is still open before
deciding whether to retry.

**Files changed.** `src/cli/pr.ts` (270 insertions / 22 deletions),
`src/cli/index.ts` (+12 lines for engine knob plumbing),
`src/cli/help-text.ts` (+8 lines for the per-verb Options block +
breadcrumb), `tests/cli/pr-engine-smoke.test.ts` (new, 306 lines),
`docs/v6/wrapping-pipeline-phases.md` (status header + table row +
deviation note), `docs/v6/migration-guide.md` ("what works today" list
adds `pr`), `docs/specs/v6-run-state-engine.md` (reconciliation block
appended). Total: ~600 lines added, ~25 lines removed.

**Status after v6.0.9.** Nine of 10 phases wrapped. Remaining:
`implement` (v6.0.7) and `migrate` (v6.0.8) — both side-effecting,
both wrapped concurrently with this PR by parallel agents.
- **Bundled UI polish skills** — ships `/ui`, `/simplify-ui`, `/ui-ux-pro-max`,
  `/make-interfaces-feel-better` so consumers get them via `npm install` instead
  of needing user-level skill installs. `/ui` runs the chained pass (audit →
  simplify → align → polish); the other three are individual lenses. Auto-
  discovered via the existing `skills/` directory in the package `files`
  allowlist. Pairs with the design context loader
  (`src/core/ui/design-context-loader.ts`) — both gate on the same
  `hasFrontendFiles()` predicate so they only fire when frontend files change.

## v6.0.7 — wrap `implement` through `runPhaseWithLifecycle` (2026-05-07)

**Wraps the ninth pipeline phase.** Mechanical wrap following the v6.0.6
helper recipe. Engine-off path is byte-for-byte unchanged (advisory print
pointing at the Claude Code `claude-autopilot` skill); engine-on path
creates a run dir + emits run.start / phase.start / phase.success /
run.complete events. Concurrent dispatch — landed alongside v6.0.8
(`migrate`) and v6.0.9 (`pr`).

- New `src/cli/implement.ts` — `RunPhase<ImplementInput, ImplementOutput>`
  with `idempotent: true, hasSideEffects: false`. **Documented deviation
  from spec table:** the spec at line 159 of
  `docs/specs/v6-run-state-engine.md` lists `implement` with
  `idempotent: partial, hasSideEffects: yes, externalRefs: git-remote-push`.
  That declaration assumes the verb itself writes commits and pushes them
  to a remote. The v6.0.7 CLI verb does **not** write code, run tests,
  commit, or push to a remote — all of that lives in the Claude Code
  `claude-autopilot` skill (and its delegates: `subagent-driven-development`,
  `commit-push-pr`, `using-git-worktrees`). The CLI verb is the engine-wrap
  shell — its only side effect is writing the local
  `.guardrail-cache/implement/<ts>-implement.md` log stub. If a future PR
  inlines the implement loop into the CLI verb, the declarations flip to
  match the spec table and a `ctx.emitExternalRef({ kind: 'git-remote-push',
  id: '<commit-sha>' })` call lands after each push.
- CLI dispatcher in `src/cli/index.ts` — wires `--engine` / `--no-engine` /
  `--context` / `--plan` / `--output` / `--config` through the helper
  alongside `process.env.CLAUDE_AUTOPILOT_ENGINE`. Mirrors the validate /
  review / plan dispatcher shape.
- Help text in `src/cli/help-text.ts` — adds `implement` to the Pipeline
  group + per-verb Options block. Bumps `GLOBAL_FLAGS_BLOCK` to cite
  v6.0.7 alongside v6.0.1 → v6.0.5.
- New smoke test `tests/cli/implement-engine-smoke.test.ts` (6 cases) —
  asserts state.json + events.ndjson lifecycle, idempotent /
  hasSideEffects flags, env / CLI precedence, log file location.
- Test count: 1408 → 1414 (+6). `npm test` clean. `npx tsc --noEmit`
  clean except pre-existing fixture errors.

## v6.0.8 — wrap `migrate` through `runPhaseWithLifecycle` (2026-05-06)

**First side-effecting phase under the engine.** v6.0.1 → v6.0.6 wrapped
eight read-only / advisory verbs (`scan`, `costs`, `fix`, `brainstorm`,
`spec`, `plan`, `review`, `validate`). v6.0.8 wraps `migrate` — the
first verb that mutates external state (database schema). Builds on the
`runPhaseWithLifecycle` helper landed in v6.0.6 plus
`ctx.emitExternalRef()` from inside the phase body for the
`migration-version` ledger. No helper-shape changes needed.

**Phase declarations** match the spec table at line 162 of
`docs/specs/v6-run-state-engine.md`:

```
idempotent:     false   — dispatcher output varies by ledger state
                          (N applied on attempt 1, 0 on attempt 2 even
                          though both are operationally safe)
hasSideEffects: true    — applies migrations, writes audit log,
                          regenerates types, refreshes schema cache
externalRefs:   migration-version, scoped `<env>:<name>` per applied
                migration. Phase 6's resume gate will read these back
                against the live `migration_state` to decide
                skip-already-applied vs retry vs needs-human.
```

**Why `idempotent: false` even though the underlying Delegance migrate
skill is ledger-guarded against double-apply:** at the *engine
semantics* layer, `idempotent: true` means "re-running the phase against
the same input produces equivalent output." A dispatch invocation that
previously applied N migrations on attempt 1 and applies 0 on attempt 2
(everything already in the ledger) DOES produce different output
(different `appliedMigrations` list, different `status`). The spec's
`idempotent: false` is correct.

**Engine-off path is byte-for-byte identical to v6.0.7.** Same dispatch
shape (`src/core/migrate/dispatcher.ts` unchanged), same render lines,
same `--json` payload callback. CI / scripts that don't pass `--engine`
are unaffected.

| File | Role |
|---|---|
| `src/cli/migrate.ts` (new) | Engine-wrap shell calling `runMigrate(opts) → { exitCode, result }`. Defines `MigrateInput` / `MigrateOutput` (JSON-serializable), `RunPhase<MigrateInput, MigrateOutput>` with `name: 'migrate'`, `idempotent: false`, `hasSideEffects: true`. Phase body invokes the dispatcher and emits one `migration-version` externalRef per applied migration via `ctx.emitExternalRef({ kind: 'migration-version', id: '<env>:<name>' })`. Test seam: `__testDispatch` injects a fake dispatcher so smoke tests can exercise the engine-wrap path without spawning a child process or hitting a real database |
| `src/cli/index.ts` | dispatcher case for `migrate` routes through `runMigrate` instead of inlining `runMigrateDispatch`; threads `cliEngine` + `envEngine`. Engine-off byte-for-byte unchanged — same `--json` payload callback, same render |
| `src/cli/help-text.ts` | per-verb Options block for `migrate` documents `--engine` / `--no-engine` + `--config`; GLOBAL_FLAGS_BLOCK breadcrumb cites v6.0.8 |
| `tests/cli/migrate-engine-smoke.test.ts` (new) | 6 cases: engine off (default — no run dir), engine on (lifecycle events, state.json shape, idempotent: false + hasSideEffects: true declaration), externalRef emission per applied migration scoped by env, skipped status (zero externalRefs), dispatcher error → exit 1 + engine still records phase.success (domain failure ≠ engine failure), CLI `--no-engine` beats env on |
| `docs/v6/wrapping-pipeline-phases.md` | phase-status table flips `migrate` to "WRAPPED in v6.0.8"; status line at top moves to "NINE phases wrapped"; new deviation note documents the ledger-vs-engine-semantics rationale |
| `docs/v6/migration-guide.md` | "What works today" updated — three knobs now honored by `scan`, `costs`, `fix`, `brainstorm`, `spec`, `plan`, `review`, `validate`, `migrate` |
| `docs/specs/v6-run-state-engine.md` | new "What was actually built (v6.0.8)" reconciliation block |

**Test delta:** 1408 → 1414 (+6). Typecheck clean. All 1408 existing
tests pass unchanged — the engine-off path for `migrate` is byte-for-
byte identical to v6.0.7 (same dispatch shape, same render).

**Concurrency note.** v6.0.7 (`implement`) and v6.0.9 (`pr`) are in
flight on parallel worktrees, both targeting shared docs (CHANGELOG,
recipe table, migration-guide) and `src/cli/{index,help-text}.ts`. The
rebase contract: on push rejection, fetch + rebase + resolve conflicts
keeping all wraps' contributions, re-test, push with `--force-with-lease`.

**Not done in v6.0.8 — explicit non-goals:**
- Wrapping `implement` and `pr`. Continues across v6.0.7 / v6.0.9
  using the same helper plus `ctx.emitExternalRef()` for
  `git-remote-push` (implement) and `github-pr` (pr).
- Wiring Phase 6's `migration_state` read-back. The engine PERSISTS
  `migration-version` externalRefs in v6.0.8; consulting them on
  resume ships in Phase 6+. Until then, retries on side-effecting
  phases require `--force-replay`.
- Multi-phase pipeline orchestrator (autopilot's full
  `brainstorm → spec → plan → ... → migrate → ...` flow under one runId).
- Flipping the v6.0 built-in default to ON. v6.1 territory.

## v6.0.6 — `runPhaseWithLifecycle` helper (2026-05-06)

**Tech-debt refactor, no behavior change.** v6.0.1 → v6.0.5 wrapped eight
CLI verbs (`scan`, `costs`, `fix`, `brainstorm`, `spec`, `plan`, `review`,
`validate`) by hand-rolling the same ~100-line lifecycle pattern in each
file: `createRun → optional run.warning → runPhase → run.complete →
state.json refresh → best-effort lock release in finally`. Bugbot caught
the duplication on PR #97 (LOW severity, deferred) with the explicit
note: "extracting from 5 of 10 examples risks getting the abstraction
wrong; from 10 of 10 the pattern is fully evidenced." At 8 of 10, the
pattern is sufficiently evidenced that the remaining three side-effecting
phases (`implement`, `migrate`, `pr`) can use the same helper plus
`ctx.emitExternalRef()` from inside their phase body — no helper-shape
changes needed.

**The helper.** New `src/core/run-state/run-phase-with-lifecycle.ts` sits
on top of the existing `runPhase()` API (which is unchanged). Callers
continue to define their own `RunPhase<I, O>` with per-phase
`idempotent` / `hasSideEffects` / `run`, and pass it in alongside the
input, the loaded config, the engine knobs, and an `runEngineOff`
escape-hatch callback. The helper:

- Resolves engine on/off via the canonical CLI > env > config > default
  precedence
- On engine-off: invokes `runEngineOff()` and returns its result with
  `runId/runDir: null`
- On engine-on: creates a run dir, optionally emits `run.warning` for
  invalid env, runs the phase, emits `run.complete` (success or failed),
  refreshes `state.json` from replayed events, releases the lock in
  `finally` (idempotent), and returns `{ output, runId, runDir }`
- On phase failure: emits `run.complete` with `status: 'failed'`, prints
  the legacy `[<phase>] engine: phase failed — <msg>` banner to stderr
  byte-for-byte, releases the lock, and re-throws

**Migrated phases.** All eight wrapped verbs reduced. Each `runX(opts)`
function shrinks: keep the per-phase `RunPhase<I, O>` definition + the
engine-off path body; delete the lifecycle boilerplate; call
`runPhaseWithLifecycle` once. Total reduction across `src/cli/`:

- `scan.ts` 498 → 429 lines (-69)
- `costs.ts` 297 → 231 lines (-66)
- `fix.ts` 473 → 415 lines (-58)
- `brainstorm.ts` 251 → 189 lines (-62)
- `spec.ts` 216 → 159 lines (-57)
- `plan.ts` 269 → 199 lines (-70)
- `review.ts` 256 → 189 lines (-67)
- `validate.ts` 262 → 196 lines (-66)
- **Total: 2522 → 2007 lines (~515 lines saved)**

**Engine-off path is byte-for-byte unchanged.** All eight existing
`tests/cli/<verb>-engine-smoke.test.ts` smokes pass without modification
(44 cases). The helper supplies an `runEngineOff` callback so the legacy
code path stays intact even when the phase body's call shape would
otherwise pin it.

### Test count

After v6.0.5 baseline: 1396 → 1408 (+12). +12 cases for the new
`tests/run-state/run-phase-with-lifecycle.test.ts` covering: engine-off
(default + CLI > env > config precedence); engine-on success (lifecycle
events, state.json shape, env / config resolution, costUSD pass-through,
costUSD-absent fallback to 0); engine-on failure (run.complete failed,
state.json refresh, error re-thrown with original message preserved,
lock released through finally); invalid env value falling through to
config-resolved engine-on with `run.warning`. Existing 44 phase smokes
unchanged. Typecheck clean. Bugbot LOW from PR #97 addressed.

### Deliberately deferred

- Wrapping the remaining pipeline phases (`implement`, `migrate`, `pr`).
  Side-effecting phases need careful externalRef plumbing — they will
  build against `runPhaseWithLifecycle` plus `ctx.emitExternalRef()`
  from inside their phase body. Helper signature does not need to grow
  for them; documented in the helper's header comment.
- Multi-phase pipeline orchestrator (autopilot's full
  `brainstorm → spec → plan → ...` flow under one runId). The single-
  phase shape stays — multi-phase wrapping is a separate v6.x lift.
- Flipping the v6.0 built-in default to ON. v6.1 territory.

## v6.0.5 — Engine wire-up Part E (2026-05-06)

**The headline.** v6.0.4 wrapped `plan` and `review`. v6.0.5 continues the
mechanical wrap pattern from the recipe at
[`docs/v6/wrapping-pipeline-phases.md`](docs/v6/wrapping-pipeline-phases.md)
with one more single-shot, read-only verb:

- **`validate`** — new CLI verb. Engine-wrap shell for the validate
  pipeline phase. Writes a validate log stub under
  `.guardrail-cache/validate/`; the actual validation work (static
  checks, auto-fix, tests, Codex review with auto-fix, bugbot triage) is
  owned by the Claude Code `/validate` skill. Declared `idempotent: true,
  hasSideEffects: false` (local file write only; no provider calls, no
  git push, no PR comment, no SARIF upload).

**Documented deviation from the spec table.** The v6 spec
([docs/specs/v6-run-state-engine.md](docs/specs/v6-run-state-engine.md),
line 161) lists `validate` with externalRefs `sarif-artifact`. The
v6.0.5 wrap matches the `idempotent: true, hasSideEffects: false`
declaration but does **not** plumb a `sarif-artifact` externalRef — the
v6.0.5 `validate` CLI verb does not emit a SARIF artifact. SARIF
emission lives in `claude-autopilot run --format sarif --output <path>`
(a separate verb). The SARIF reference is local-only file output (no
remote upload), so the engine doesn't need a readback rule for it on
resume — `idempotent: true` covers replay safety. If a future PR adds
SARIF emission directly to this verb, the wrap can add a
`ctx.emitExternalRef({ kind: 'sarif-artifact', ... })` call after the
file write lands. Documented inline in `src/cli/validate.ts` and in the
wrapping recipe's deviation note.

The engine-off code path is byte-for-byte unchanged; the `validate`
verb is brand new in v6.0.5 (validation previously lived only as a
Claude Code skill).

### Test count

After v6.0.4 baseline: 1390 → 1396 (+6). +6 cases for
`validate-engine-smoke.test.ts`, mirroring the
`review-engine-smoke.test.ts` shape: engine off → no run dir + log
written; engine off (cliEngine: false); engine on → state.json +
events.ndjson with the right lifecycle (`run.start` →
`phase.start` → `phase.success` → `run.complete`); engine on with
explicit `--context`; env-resolved; CLI override beats env. Typecheck
clean.

### Deliberately deferred

- Wrapping the remaining pipeline phases (`implement`, `migrate`,
  `pr`). Side-effecting phases need careful externalRef plumbing per
  the recipe's "side effects" gate; wrap them last.
- Adding SARIF emission directly to the `validate` verb. Lives in
  `claude-autopilot run --format sarif` (separate verb).
- Extracting a shared `runPhaseWithLifecycle` helper across the eight
  wrapped verbs. Separate refactor PR — out of scope for v6.0.5.
- Flipping the v6.0 built-in default to ON. v6.1 territory.

## v6.0.4 — Engine wire-up Part D (2026-05-06)

**The headline.** v6.0.3 wrapped `brainstorm` and `spec`. v6.0.4 continues
the mechanical wrap pattern from the recipe at
[`docs/v6/wrapping-pipeline-phases.md`](docs/v6/wrapping-pipeline-phases.md)
with two more single-shot verbs:

- **`plan`** ([#98](https://github.com/axledbetter/claude-autopilot/pull/98)) —
  new CLI verb. Engine-wrap shell for the plan pipeline phase. Writes a
  plan markdown stub under `.guardrail-cache/plans/`; the actual
  LLM-driven planning content is owned by the Claude Code
  superpowers:writing-plans skill. Declared `idempotent: true,
  hasSideEffects: false` (local file write only; no provider calls, no
  git push, no PR comment).
- **`review`** ([#98](https://github.com/axledbetter/claude-autopilot/pull/98)) —
  new CLI verb. Engine-wrap shell for the review pipeline phase. Writes
  a review log stub under `.guardrail-cache/reviews/`; the actual
  LLM-driven review content is owned by the Claude Code review skills
  (`/review`, `/review-2pass`, `pr-review-toolkit:review-pr`). Declared
  `idempotent: true, hasSideEffects: false`.

**Documented deviation from the spec table.** The v6 spec
([docs/specs/v6-run-state-engine.md](docs/specs/v6-run-state-engine.md))
lists `review` with externalRefs `review-comments`, implying PR-side
comment posting (which would force `hasSideEffects: true`). The v6.0.4
`review` verb does **not** post anywhere — PR-side comment posting
lives in `claude-autopilot pr --inline-comments` /
`--post-comments` (a separate verb). If a future PR adds platform-side
comment posting to this verb, both declarations will need to flip and
the readback rules will need to plumb a `review-comments` externalRef.
Documented inline in `src/cli/review.ts`.

**Backward-compat — `review` grouping prefix preserved.**
`claude-autopilot review` (no args) still prints the alpha.2 prefix
help banner per the V16 v4-compat test. Flat-verb invocation requires
at least one flag, e.g. `claude-autopilot review --engine`.
`claude-autopilot help review` continues to surface the flat-verb
Options block via `buildCommandHelpText`.

Engine-off code paths are unchanged for both verbs.

### Test count

After v6.0.3 baseline: 1378 → 1390 (+12). +6 cases for
`plan-engine-smoke.test.ts`, +6 cases for `review-engine-smoke.test.ts`.
Both mirror `costs-engine-smoke.test.ts`: engine off → no run dir;
engine on → state.json + events.ndjson with the right lifecycle
(`run.start` → `phase.start` → `phase.success` → `run.complete`);
env-resolved; CLI override beats env. Typecheck clean.

### Deliberately deferred

- Wrapping the remaining pipeline phases (`implement`, `migrate`,
  `validate`, `pr`). Side-effecting phases (`implement`, `migrate`,
  `pr`) need careful externalRef plumbing per the recipe's "side
  effects" gate; wrap them last.
- Flipping the v6.0 built-in default to ON. v6.1 territory.

## v6.0.3 — Wrap brainstorm + spec through runPhase (2026-05-05)

**The headline.** v6.0.3 continues the mechanical phase-wrap pattern from
the recipe at
[`docs/v6/wrapping-pipeline-phases.md`](docs/v6/wrapping-pipeline-phases.md)
with two more pipeline verbs:

- **`brainstorm`** — the pipeline entry point. Implemented primarily as
  a Claude Code skill (`/brainstorm` → `superpowers:brainstorming`); the
  CLI verb is an advisory shim pointing the user there. The wrap declares
  `idempotent: true, hasSideEffects: false`. Engine-off path is
  byte-for-byte identical to v6.0.2 (the same advisory banner). Engine-on
  path creates a run dir + emits `run.start` / `phase.start` /
  `phase.success` / `run.complete`. `--json` envelope shape is preserved
  for back-compat with the WS7 welcome regression guard and
  `json-channel-discipline.test.ts`.
- **`spec`** — same shape as brainstorm. New top-level subcommand (it
  was previously absent from `SUBCOMMANDS`); the CLI verb is an advisory
  shim pointing at the autopilot/brainstorm Claude Code flow. Same wrap
  flags + same engine lifecycle.

**Documented deviation from the spec table.** The
[v6 spec table](docs/specs/v6-run-state-engine.md) declares both
`brainstorm` and `spec` `idempotent: no` because the LLM dialogue
produces new content each invocation. v6.0.3 declares `idempotent: true`
because the CLI verbs themselves are static advisory prints with no LLM
call and no externalRefs to reconcile — the engine's idempotency check
is "safe to retry without reconciliation," not "produces byte-identical
output." Justified inline at the top of `src/cli/brainstorm.ts` and
`src/cli/spec.ts` plus a deviation block in the recipe. Once the CLI
verbs grow real LLM bodies (a future v6.x lift), the declaration may
flip and a `spec-file` externalRef will land on every successful run.

Engine-off code paths are unchanged for both verbs; existing tests pass
without modification.

### Test count

1367 → 1378 (+11). +5 cases for `brainstorm-engine-smoke.test.ts`, +5
cases for `spec-engine-smoke.test.ts`, +1 case for `spec` joining
`MIGRATED_VERBS` in `json-channel-discipline.test.ts`. Both new smoke
files mirror `costs-engine-smoke.test.ts`: engine off → no run dir;
engine on → state.json + events.ndjson with the right lifecycle
(`run.start` → `phase.start` → `phase.success` → `run.complete`);
env-resolved; CLI override beats env. Typecheck clean.

### Deliberately deferred

- Wrapping the six remaining pipeline phases (`plan`, `implement`,
  `migrate`, `validate`, `pr`, `review`). One or two per release across
  v6.0.4+. A parallel agent works `plan` + `review` for v6.0.4.
- Promoting `brainstorm`/`spec` from advisory shims to full LLM-bearing
  CLI verbs. The Claude Code skill remains the user-facing entry point;
  the CLI wraps exist so the engine has a place to record run-state for
  future multi-phase orchestration.

## v6.0.2 — Engine wire-up Part B (2026-05-06)

**The headline.** v6.0.1 wrapped the first pipeline phase (`scan`) through
`runPhase`. v6.0.2 continues the mechanical wrap pattern from the recipe at
[`docs/v6/wrapping-pipeline-phases.md`](docs/v6/wrapping-pipeline-phases.md)
with two more single-shot verbs:

- **`costs`** ([#96](https://github.com/axledbetter/claude-autopilot/pull/96)) —
  pure read-only summary of the local cost ledger. The cleanest possible
  wrap: `idempotent: true, hasSideEffects: false`, no provider, no LLM,
  no file writes. CLI dispatcher passes `cliEngine` + `envEngine` through;
  `--config` flag also wired since the engine resolver consults config.
- **`fix`** ([#96](https://github.com/axledbetter/claude-autopilot/pull/96)) —
  applies LLM-generated patches to local files. Declared
  `idempotent: true` (same finding + same file content → same patch) and
  `hasSideEffects: false` (no remote / git push / PR creation in the
  existing flow — purely local file edits, which the recipe defines as
  platform-side-effect-free). If/when fix grows a `--push` mode it will
  flip to `hasSideEffects: true` with a `git-remote-push` externalRef.

**Documented deviation from the recipe.** Both wraps follow the recipe
mechanically. `fix` adds one explicit deviation: its phase body emits
per-finding console output and reads a [y/n/q] confirmation via
`readline`. Pure side-effect-free phase bodies are the recipe default,
but interactive verbs are an explicit exception (same precedent as
`scan` keeping its LLM call inside `executeScanPhase`). The summary line
+ exit-code logic still lives in `renderFixOutput` so the engine path's
idempotency isn't coupled to the final stdout shape. See the new "Note
on interactive verbs" section at the bottom of the wrapping recipe.

Engine-off code paths are byte-for-byte unchanged for both verbs;
existing tests pass without modification.

### Test count

1356 → 1367 (+11). +6 cases for `costs-engine-smoke.test.ts`, +5 cases
for `fix-engine-smoke.test.ts`. Both mirror `scan-engine-smoke.test.ts`:
engine off → no run dir; engine on → state.json + events.ndjson with
the right lifecycle (`run.start` → `phase.start` → `phase.success` →
`run.complete`); env-resolved; CLI override beats env. Typecheck clean.

### Deliberately deferred

- Wrapping the seven remaining pipeline phases (`brainstorm`, `plan`,
  `implement`, `migrate`, `validate`, `pr`, `review`). One or two per
  release across v6.0.3+.
- Flipping the v6.0 built-in default to ON. v6.1 territory.

## v6.0.1 — Engine wire-up Part A (2026-05-05)

**The headline.** v6.0 shipped the engine modules but left the user-facing
knobs un-wired. This release lights up the three knobs (`--engine` /
`--no-engine` CLI flag, `CLAUDE_AUTOPILOT_ENGINE` env var,
`engine.enabled` config key) with explicit precedence (CLI > env > config
> built-in default) and wraps the **first** pipeline phase — `scan` —
through `runPhase`. Every other pipeline phase still bypasses the engine;
those land one or two per PR across subsequent v6.0.x releases following
the recipe at [`docs/v6/wrapping-pipeline-phases.md`](docs/v6/wrapping-pipeline-phases.md).

The engine still ships **OFF** by default in v6.0.x. The default flip to
**ON** lands in v6.1 per [`docs/specs/v6.1-default-flip.md`](docs/specs/v6.1-default-flip.md).

### What landed (PR #95)

- **`resolveEngineEnabled()` precedence resolver.** Pure / no-IO function
  in `src/core/run-state/resolve-engine.ts`. Inputs:
  `{cliEngine?, envValue?, configEnabled?, builtInDefault?}`. Outputs:
  `{enabled, source, reason, invalidEnvValue?}`. Accepts case-insensitive
  env values `on/off/true/false/1/0/yes/no` (plus whitespace tolerance);
  invalid values fall through to the next-lowest precedence layer and
  surface the raw string in `invalidEnvValue` so the caller can emit a
  `run.warning`. **+45 unit tests** covering every precedence layer, every
  accepted env form, the conflict rules, and the invalid-env fallthrough.
- **CLI flag parsing in `src/cli/index.ts`.** New `parseEngineCliFlag()`
  helper rejects the conflict case (both `--engine` AND `--no-engine`)
  with `invalid_config` exit 1. Wired into the `scan` case to pass
  `cliEngine` + `envEngine` (from `process.env.CLAUDE_AUTOPILOT_ENGINE`)
  through to `runScan`.
- **Config schema** (`src/core/config/types.ts` + `schema.ts`). New
  optional `engine.enabled: boolean` knob; schema rejects unknown
  sub-keys (`additionalProperties: false`).
- **Help text** (`src/cli/help-text.ts`). New `GLOBAL_FLAGS_BLOCK`
  documents `--json` / `--engine` / `--no-engine` + the precedence
  matrix + scope (scan only in v6.0.1; rest follows the recipe). Per-verb
  `scan` Options block adds the new flags so `claude-autopilot help scan`
  is self-contained.
- **`scan` pilot phase wrapping** (`src/cli/scan.ts`). Refactored the
  LLM-call-and-finding-processing portion into `executeScanPhase(input)`
  → `ScanOutput` (pure, no console output, no exit-code logic). Defined
  `RunPhase<ScanInput, ScanOutput>` with `name: 'scan'`,
  `idempotent: true`, `hasSideEffects: false`. Engine-on path:
  `createRun()` → `runPhase()` → `run.complete` event +
  `replayState`/`writeStateSnapshot` refresh + best-effort lock release
  in `finally`. Engine-off path: `executeScanPhase(input)` directly,
  byte-for-byte unchanged from v6.0. Rendering extracted into
  `renderScanOutput()` so the engine path's idempotency isn't coupled
  to console output. Test seam (`__testReviewEngine`) lets the smoke test
  inject a fake without an LLM key.
- **End-to-end smoke test** (`tests/cli/scan-engine-smoke.test.ts`).
  Drives `runScan` with the engine on against a tmp project; asserts
  `state.status === 'success'`, single `scan` phase with the right
  `idempotent` / `hasSideEffects` flags, monotonic seq numbers, and the
  full lifecycle (`run.start` → `phase.start` → `phase.success` →
  `run.complete`). Five cases including engine-off (no run dir),
  env-resolved, CLI override, and invalid-env-fallthrough warning.
- **Wrapping recipe doc** (`docs/v6/wrapping-pipeline-phases.md`).
  Six-step recipe + phase-status table + idempotency decision tree +
  worked example (scan) + a checklist subsequent v6.0.x PRs follow when
  wrapping the remaining ten pipeline phases (`brainstorm`, `plan`,
  `implement`, `migrate`, `validate`, `pr`, `review`, `fix`, `costs`).
- **Migration guide** (`docs/v6/migration-guide.md`). "What works today"
  list updated — three knobs move from "wiring pending" to "wired (limited
  to scan)". Other phases still tracked under "wiring pending."
- **Spec reconciliation** (`docs/specs/v6-run-state-engine.md`). New "What
  was actually built (v6.0.1 — Part A)" block.

### Test count

1306 → 1356 (+50). Typecheck clean. Existing 1306 tests continue to pass
unchanged — the engine-off code path for `scan` is byte-for-byte
identical to v6.0.

### Deliberately deferred

- Wrapping of any other pipeline phase. Lands one or two per PR across
  v6.0.2+ following the recipe.
- Flipping the v6.0 built-in default to ON. v6.1 territory.
- Removing `--no-engine`. v7 territory.

## v6.0 — Run State Engine (2026-05-05)

**The headline.** Autopilot moves from a stateless command-stream to a
checkpointed, resumable, budget-bounded, observable pipeline. Every run gets
a ULID and a per-project directory at `.guardrail-cache/runs/<ulid>/`.
Every state transition appends a typed event to `events.ndjson` and updates
`state.json` atomically. Two-layer budget enforcement (advisory `estimateCost`
preflight + mandatory runtime guard) hard-stops runaway spend before it
happens. Every CLI verb grows a `--json` flag with strict stdout/stderr
channel discipline so CI consumers can drive the pipeline programmatically.
Side-effect phase replay decisions consult persisted `externalRefs` plus a
live provider read-back so resume is safe by construction. **v6.0 ships
with the engine OFF by default — opt-in via `engine.enabled: true` (config
wiring across 6.0.x point releases). Default flips to ON in v6.1.** See
[`docs/v6/migration-guide.md`](docs/v6/migration-guide.md) for the v5.x → v6
walkthrough and [`docs/v6/quickstart.md`](docs/v6/quickstart.md) for the
five-minute version.

### Per-phase landings

- **Phase 1 — Run State Engine persistence layer ([#86](https://github.com/axledbetter/claude-autopilot/pull/86)).** `RunState` / `RunEvent` / `PhaseSnapshot` / `ExternalRef` / `WriterId` types in `src/core/run-state/types.ts`. Pure-TS 26-char Crockford Base32 ULID generator (`ulid.ts`). Per-run advisory lock via `proper-lockfile` + `.lock-meta.json` sidecar with PID + SHA-256-hashed hostname; off-host writers default to alive (fail closed) so a network-mounted lock can't be stolen. Durable append protocol for `events.ndjson` (`open(O_APPEND)` → `write` → `fsync(fd)` → `close` per event) with monotonic `seq` via `.seq` sidecar. Truncated last-line detection emits `run.recovery(reason: 'recovered-from-partial-write')` and continues; mid-file corruption throws `partial_write` immediately. Atomic snapshot writer for `state.json` (`open(.tmp)` → `fsync(fd)` → `rename` → `fsync(dirfd)`; tmpfs/SMB compatibility via swallowed EISDIR/EPERM/ENOTSUP on the dir-fsync). `recoverState` falls back to events replay when `state.json` is missing/corrupt. `createRun` / `listRuns` / `gcRuns` lifecycle helpers; symlink-safe GC. New `ErrorCode` variants: `lock_held`, `corrupted_state`, `partial_write`. **+56 tests.**
- **Phase 2 — Phase wrapper + lifecycle ([#87](https://github.com/axledbetter/claude-autopilot/pull/87)).** `RunPhase<I, O>` interface (`idempotent` / `hasSideEffects` / `estimateCost?` / `run` / `onResume?`). `runPhase` orchestrator emits `phase.start` → `phase.success`/`failed` and gates idempotent short-circuit + side-effecting replay. Atomic per-phase snapshot writer (`writePhaseSnapshot` with path-traversal rejection on phase names). Hidden CLI verb `claude-autopilot internal log-phase-event` exposed via `cli-internal.ts` so markdown-driven skills can append events without importing the engine. Sub-phase nesting via synthetic `phaseIdx` encoding (`parentIdx * 1000 + childOrdinal`). **+27 tests.** Spec deviation: idempotent-replay short-circuit emits `run.warning(details.reason: 'idempotent-replay')` instead of a new `phase.skipped` event variant — durable log doesn't need a new shape since the snapshot is identical.
- **Phase 3 — `runs` / `run resume` CLI ([#88](https://github.com/axledbetter/claude-autopilot/pull/88)).** Six verbs: `runs list` (newest-first, `--status` filter), `runs show <id>` (state + optional events tail), `runs gc` (default 30-day cutoff, confirmation gate), `runs delete <id>` (terminal-status guard + lock acquisition), `runs doctor` (replay vs snapshot drift; `--fix` rewrites), `run resume <id>` (**lookup-only** in v6.0 — identifies next phase + decision rationale; live execution wires in 6.1+). Every verb supports `--json` envelope output (v1 schema). New `Engine` group in `HELP_GROUPS`. Decision vocabulary (`retry` / `skip-idempotent` / `needs-human` / `already-complete`) preserved as a thin wrapper around the canonical `decideReplay` matrix introduced in Phase 6. **No changes to existing CLI verbs.**
- **Phase 4 — Budget enforcement ([#89](https://github.com/axledbetter/claude-autopilot/pull/89)).** `BudgetConfig` (`perRunUSD`, `perPhaseUSD?`, `councilMaxRecursionDepth?`, `bgAutopilotMaxRoundsPerSelfEat?`, `conservativePhaseReserveUSD?`). `checkPhaseBudget` pure decision function with two-layer policy: (1) advisory — uses `estimateCost.high` if the phase declares one; (2) mandatory — runs regardless, enforces `actualSoFar + conservativePhaseReserveUSD <= perRunUSD` so phases without `estimateCost` still trigger budget gates. `runPhase` emits a `budget.check` event with full decision rationale (`{phase, phaseIdx, estimatedHigh, actualSoFar, reserveApplied, capRemaining, decision, reason}`) before every spawn; throws `GuardrailError(budget_exceeded)` on hard-fail. Council synthesizer recursion bounded via `councilMaxRecursionDepth` — exceeded calls return `status: 'partial'` rather than continuing. **+25-30 tests.**
- **Phase 5 — Typed JSON events + strict `--json` channel discipline ([#90](https://github.com/axledbetter/claude-autopilot/pull/90)).** `--json` flag now lives on every Review / Pipeline / Deploy / Migrate / Diagnostics verb. Strict channel contract enforced by a dispatcher-level wrapper (`runUnderJsonMode` in `src/cli/json-envelope.ts`): exactly **one** JSON envelope on stdout per invocation; **only** NDJSON event lines on stderr (synthetic `run.warning` for legacy text via `installJsonModeChannelDiscipline` console-wrap); ANSI color codes stripped; interactive prompts hard-fail with `EXIT_NEEDS_HUMAN = 78` and the envelope's `nextActions` field carries the resume hint. Text-mode behavior unchanged. **`tests/cli/json-channel-discipline.test.ts` asserts the invariants per migrated verb.**
- **Phase 6 — Idempotency contracts + provider read-back ([#91](https://github.com/axledbetter/claude-autopilot/pull/91)).** `decideReplay` pure decision matrix in `replay-decision.ts` maps `(priorSuccess, idempotent, hasSideEffects, refs, readbacks, forceReplay)` → `'retry' | 'skip-already-applied' | 'needs-human' | 'abort'`. Pluggable `ProviderReadback` registry in `provider-readback.ts` with built-in read-backs for `github` (via `gh` CLI), `vercel` / `fly` / `render` (via the deploy adapters), `supabase` (via `migration_state`). All read-backs **fail closed** — any throw, parse failure, or unrecognized state collapses to `existsOnPlatform=false, currentState='unknown'` so the matrix routes to `needs-human` instead of a silent skip. `runPhase` wires `decideReplay` (replaces Phase 2's hard-coded throw). New `replay.override` event variant emitted when `--force-replay` flips a refusal into a retry; `foldEvents` records overrides on `phase.meta.replayOverrides`. `PhaseSnapshot.result` field added so `skip-already-applied` returns the prior output without re-execution. CLI lookup (`runRunResume`) delegates to the same `decideReplay` so prediction matches live execution. **+55 tests.**
- **Phase 7 — Live adapter certification suite ([#92](https://github.com/axledbetter/claude-autopilot/pull/92)).** Five live assertions × three providers (Vercel + Fly + Render): deploy success, auth failure, 404, rollback, log streaming with redaction-on-planted-secret. Env-gated via `resolveProviderEnv()` — runs report `skipped` until the operator adds the seven `*_TEST` GitHub Secrets per `docs/adapters/cert-suite.md`. Flake-control harness (`tests/adapters/live/_harness.ts`) implements per-provider 3-attempt retry budget with exp backoff (1s / 4s / 16s) on transient categories, hard-fail (no retry) on auth/404/schema-mismatch, soft-fail with 3-strike escalation on rollout/log-streaming flakes; **+42 unit tests** for the harness alone (run under regular `npm test`, no live creds required). Nightly CI workflow at `.github/workflows/adapter-cert.yml` (09:00 UTC + manual `workflow_dispatch`); uploads `events.ndjson` + `log-tail.txt` artifacts on every run. **Spec deviation:** Fly cert needs a third env var (`FLY_IMAGE_TEST`) since the Fly adapter doesn't build images per the v5.6 design.
- **Phase 8 — Docs + migration guide ([#94](https://github.com/axledbetter/claude-autopilot/pull/94), this PR).** `docs/v6/migration-guide.md` walks v5.x users through the opt-in flow with a precedence matrix, troubleshooting recipes, the per-phase idempotency table, and the v6.0 → v6.1 default-flip plan. `docs/v6/quickstart.md` is the five-minute version. README gains a "Run State Engine (v6)" section. CHANGELOG (this entry) bundles every phase. Spec gets a Phase 8 reconciliation block + a Status column on the implementation phases table. New `docs/specs/v6.1-default-flip.md` outlines the stabilization criteria for flipping `engine.enabled` to `true` by default and removing `--no-engine`.
- **Spec — Codex-reviewed twice ([#85](https://github.com/axledbetter/claude-autopilot/pull/85)).** Two passes through Codex 5.3 hardened the persistence protocol (durable append + atomic snapshot ordering), promoted `events.ndjson` to source-of-truth with `state.json` as a derived cache, mandated copy-not-symlink for artifacts, added the two-layer budget policy with a mandatory runtime guard, formalized the strict `--json` channel discipline, defined the external-operation ledger for replay safety (`ExternalRef` + provider read-back), pinned the precedence matrix, and added flake-control parameters for the live adapter cert suite.

### Codex / council pricing — from the GPT-5.5 swap ([#93](https://github.com/axledbetter/claude-autopilot/pull/93))

- **Default codex/council model bumped `gpt-5.3-codex` → `gpt-5.5`.** OpenAI
  released GPT-5.5 (codename Spud) on 2026-04-23 — better at coding than 5.4
  with fewer tokens, available via standard Responses/Chat Completions API
  at `gpt-5.5` (no `-codex` suffix). Pricing **doubles** to $5/1M input +
  $30/1M output, so the per-adapter `COST_PER_M_INPUT/OUTPUT` defaults moved
  in lockstep — without this, every cost-ledger entry would silently halve.
  New canonical pricing table at `src/adapters/pricing.ts` keeps the legacy
  `gpt-5.3-codex` and `gpt-5.4` entries for back-compat with pinned
  `CODEX_MODEL`/`council.models[].model` configs. Override via env vars
  (`CODEX_MODEL`, `CODEX_COST_INPUT_PER_M`, `CODEX_COST_OUTPUT_PER_M`).

## v5.6.0 — Fly.io + Render deploy adapters (2026-05-04)

### Added

- **`@delegance/claude-autopilot deploy --adapter fly`** — first-class Fly.io adapter. Image-based releases via the Machines API (image must be pre-pushed via `fly deploy --build-only --push`), polling-based status, **WebSocket log streaming**, **native rollback** with simulated fallback when the API endpoint is unavailable. `FLY_API_TOKEN` env var; auth doctor warns when missing.
- **`@delegance/claude-autopilot deploy --adapter render`** — first-class Render adapter. REST API deploys (with optional `clearCache`), service-scoped status polling at `GET /v1/services/{serviceId}/deploys/{deployId}`, REST-polling log stream with `(timestamp, logId)` cursor dedup, **simulated rollback** by re-deploying the previous successful commit. `RENDER_API_KEY` env var; auth doctor warns when missing.
- **`DeployAdapterCapabilities` interface** — adapters declare `streamMode: 'websocket' | 'polling' | 'none'` and `nativeRollback: boolean`. CLI prints a one-line stderr notice for polling-mode adapters under `--watch` so users understand why log lines arrive in batches.
- **Bounded auto-rollback orchestration in `src/cli/deploy.ts`** — when health check fails after deploy and `rollbackOn: [healthCheckFailure]` is configured, the CLI fires exactly one rollback (no chains), with `runHealthCheck` capped at 5 attempts × 6s backoff (~30s window). New terminal `DeployResult.status` values: `fail_rolled_back` and `fail_rollback_failed`.
- **HTTP-status error taxonomy** — new `not_found` `ErrorCode` joins the union; per-adapter mapping: 401/403→`auth`, 404→`not_found`, 422/400→`invalid_config`, 5xx→`transient_network` (retryable). Provider request-id headers (`Fly-Request-Id`, `x-request-id`) captured into `error.details` for support tickets.
- **Mandatory log redaction across all adapters** — every log line surfaced into `DeployResult.output` or PR-comment bodies runs through `redactLogLines()` (defaults: `AKIA…`, `sk-…`, `eyJ…`, `ghp_`, `xoxb-`, plus user-configurable `config.persistence.redactionPatterns`). Closes a real existing security hazard in the v5.4 Vercel adapter that was emitting unredacted logs into PR comments.
- **Shared `src/adapters/deploy/_http.ts`** — extracted `fetchWithRetry` + `safeReadBody` helpers used by Vercel, Fly, and Render adapters; one canonical retry implementation to maintain.

### Fixed

- **Bugbot caught + autopilot fixed 4 real bugs across the v5.6 self-eat phases.** HIGH on Phase 2 (Render service-scoped URL — `pollUntilTerminal` and `status()` were using shorthand `/v1/deploys/{id}` which doesn't exist on Render's API). MEDIUM on Phase 3 (Render cursor dedup wasn't sorting same-ms entries by id, silently dropping out-of-order siblings). LOW on Phase 4 (`printAutoRollback` hardcoded "failed 3x" but the constant is now 5). LOW on Phase 5 (`getPreviousFileContent` was being called for `.sql` files where `previousContent` is ignored, wasting a `git show` spawn per migration).
- **Schema-alignment diff-aware Prisma parsing (PR #44, schema-alignment cleanup)** — `getPreviousFileContent` now defaults to a CI-aware base ref (`GITHUB_BASE_REF` → `origin/<base>`, then `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, fallback `HEAD~1`) instead of always reading from `HEAD` (which gave empty diffs in CI). Dropped models now emit `drop_column` for every field of the removed model.
- **Tombstone CLI no longer crashes with a stack trace when presets are missing (PR #82)** — schema-validator was running file IO at module load time, so every `claude-autopilot --version` call eagerly read `presets/aliases.lock.json` + `presets/schemas/migrate.schema.json`; missing presets crashed the CLI before it could format an error. Now lazy-init via memoized `getValidator()`.

## v5.5.2 — Framework-agnostic /migrate (2026-04-30)

### Added

- **Working examples for Rails, Alembic, Django, golang-migrate, Prisma, Drizzle, dbmate, Flyway, supabase-cli, custom scripts** in `skills/migrate/SKILL.md`. The dispatcher was always framework-agnostic, but the prior doc text only described the Supabase path.
- **Detector `defaultCommand` fills** for `prisma-push`, `drizzle-push`, `golang-migrate`, `typeorm` so `claude-autopilot init` produces a working `stack.md` on first try for these toolchains.

### Fixed

- **`/migrate` skill description rewritten** as a generic dispatcher description with a "when to use migrate-supabase instead" callout. Anyone running `migrate@1` in a non-Supabase repo no longer sees Supabase-specific instructions.

## v5.5.1 — `openai` SDK now optional (2026-04-30)

### Changed

- **`openai` moved to `optionalDependencies`** alongside `@anthropic-ai/sdk`, `@google/generative-ai`, `@modelcontextprotocol/sdk`. All four LLM SDKs are now optional. `npm install --omit=optional` shed grows to **~26 MB** (was ~13 MB after v5.5.0). `scripts/autoregress.ts` migrated to `loadOpenAI()` — the last direct `import OpenAI` outside the adapter layer.

### Notes

- Council runner already handles missing-synth-SDK gracefully — returns `status: 'partial'` with the friendly install hint surfaced via the synthesis error field. Users with only `ANTHROPIC_API_KEY` get a partial result with model responses preserved.

## v5.5.0 — Lazy-load LLM SDKs + Vercel auth doctor (2026-04-30)

### Added

- **`src/adapters/sdk-loader.ts`** with `loadAnthropic` / `loadOpenAI` / `loadGoogleGenerativeAI` + `isSdkInstalled` helper. Friendly `GuardrailError` on `MODULE_NOT_FOUND` points at the exact `npm install` command.
- **Phase 6 of v5.4 spec — Vercel auth doctor.** `claude-autopilot doctor` detects `deploy.adapter: vercel` in `guardrail.config.yaml` and warns when `VERCEL_TOKEN` is missing.
- **LLM SDK install-state surface in doctor** — shows which optional LLM SDKs are actually installed.

### Changed

- **`@anthropic-ai/sdk`, `@google/generative-ai`, `@modelcontextprotocol/sdk` moved to `optionalDependencies`**. Six adapters converted from top-level import to dynamic load. Users with `--omit=optional` shed ~13 MB and only need the SDK matching their API key.

## v5.4.0 — Vercel first-class deploy adapter (2026-04-30)

### Added

- **`@delegance/claude-autopilot deploy --adapter vercel`** — first-class Vercel adapter via the v13 deployments API. Returns `dpl_xxx` IDs, polls status until terminal, populates `deployUrl` / `buildLogsUrl` / `output`. Auth via `VERCEL_TOKEN`.
- **`--watch` SSE+NDJSON log streaming** — subscribes to `/v2/deployments/<id>/events?builds=1`, prints to stderr in real time. Reconnects once with exp backoff on disconnect.
- **`claude-autopilot deploy rollback` + `deploy status`** — CLI subverbs over the adapter's `rollback()` / `status()` methods. `--to <id>` overrides "previous prod deploy" lookup.
- **Auto-rollback on health-check failure** — when `rollbackOn: [healthCheckFailure]` is set in config, the CLI promotes the previous prod deploy if the post-deploy health check fails. PR comment shows both URLs (new + rolled-back-to).
- **`<!-- claude-autopilot-deploy -->` upserting PR comment** — single comment is updated in place across deploy → log-stream → health-check → rollback, instead of spamming the PR with multiple comments.

### Fixed

- **Bugbot caught explicit `--config <missing>` was silently ignored on PR #63 (Phase 3)** — autopilot fixed it with a regression test in 4 minutes.
- **Phase 4 introduced a regression in Phase 2's `--watch` test surface; caught via `npm test` before PR opened**, autopilot adapted spec interpretation (made health-check opt-in instead of falling back to deployUrl) and documented the deviation.

### Notes

- This release was **shipped as four self-eat PRs** (#59, #61, #63, #64) where autopilot implemented its own next phase end-to-end. Cumulative cost ~\$17.50, wall clock ~82 min, 47 new tests. See [DEMO.md](DEMO.md) for the full proof set.
- v5.3 "deploy phase" was superseded by v5.4 — the adapter pattern subsumed the generic-command-only design from the in-flight v5.3 spec.

## v5.2.2 — Demo polish

### Fixed

- **Cost log skips zero-token entries.** Setup-flow scans, dry-runs, and no-findings paths were polluting the log with empty rows that drowned real review entries in `claude-autopilot costs` output.
- **`costs` shows scope.** Output now explicitly notes "per-project — scoped to `<cwd>/.guardrail-cache/costs.jsonl`" so users understand it's not a global aggregate.
- **`pr` no longer hard-fails on missing config.** First-run on a fresh repo now auto-detects + prints a remediation line pointing at `setup`.

### Added

- **DEMO.md committed at repo root.** Real end-to-end pipeline run on randai-johnson (multi-file Python integration, 12 min wall clock, $2.20 spend, 5 new tests, zero manual intervention). Linkable from external docs / pitch material.

## v5.2.1 — Stress-test polish

### Fixed

- **venv detection in tests phase.** `pytest -q` now resolves to `<project>/.venv/bin/pytest` (or `venv/`, `env/`) when present, so `claude-autopilot pr` no longer reports "tests failed" on Python repos with venv-installed pytest.
- **`autoregress` 100% broken on global install** — the bridge resolved `SCRIPT` to `dist/scripts/autoregress.ts` under the compiled layout, but `scripts/` ships at the package root. Every invocation threw `ERR_MODULE_NOT_FOUND`. Now uses `findPackageRoot` + existence check.
- **Council in python preset.** Python preset now ships a commented `council:` template (mirrors the generic preset). Out-of-the-box `init --preset python` no longer requires manual schema discovery.
- **Regression-lane fixture top-level await.** CI workflow's `npx tsx -e "..."` blocks wrapped in `async () => {...}` so esbuild's CJS output accepts them. Plus expected-ledger.json updated to match v5.2.0's new version format.

## v5.0.8 — Line extraction + fix gate

### Fixed

- **Parser extracts "line N" / "on line N" / "at line N" from prose** when not adjacent to a file ref. Previously findings shipped with file but no line, so `fix --dry-run` reported "no fixable findings" on a non-empty findings list.
- **`fix` distinguishes actionable (file present) from fixable (file + line).** Dry-run surfaces actionable findings even when line-less, with a clear message about why the LLM-fix loop can't act on them.

## v5.0.7 — File backfill + cost ledger consolidation

### Fixed

- **Single-file scan unconditionally backfills the file path.** The 5.0.6 fallback only triggered on `<unspecified>`, so prose-noise like `"n.r"` slipped through and broke `fix`.
- **`pr-desc` and `council` now persist to the cost ledger.** Previously only `scan` and `run` were tracked, so `claude-autopilot costs` showed misleadingly low totals after multi-call sessions.
- **Single-letter code extensions removed from bare-reference parser** (c/d/h/m/r/s) — they still match when backtick-wrapped, but bare matches like "n.r" no longer slip through.
- **`appendCostLog` swallows write errors centrally.** Cost log is observability, not a contract — a read-only FS or full disk no longer crashes commands that already succeeded.

## v5.0.6 — Setup YAML + branch fallback

### Fixed

- **`setup` no longer writes duplicate `testCommand` keys.** Several presets (go, python, python-fastapi, rails-postgres) ship with their own `testCommand:` line; `cli/setup.ts` was unconditionally appending another, producing invalid YAML that hard-failed every command after `setup` on those stacks.
- **Single-file scan backfills file path** (initial fix; superseded by v5.0.7's unconditional version).
- **Branch-derived PR titles default to `chore:` for unknown prefixes.** `autopilot-test/validate-weights` → `chore: validate weights` instead of `autopilot test validate weights` (which fails commitlint).

## v5.0.5 — Python detect + parser hardening

### Added

- **`presets/python/`** — general Python config (pytest, ruff, hardcoded-secrets, common protected paths). Detector now picks it for any `pyproject.toml` or `requirements.txt` without FastAPI signals (was falling through to the JS/Generic preset).

### Fixed

- **Parser rejects "e.g" / "i.e" / "etc" prose as file refs.** The prior regex `\.[a-z]{1,6}` accepted any 1-6 letter suffix, so prose like "(e.g. dict, list)" was matched. Bare references now require a known code-file extension.
- **`pr-desc` real titles.** Prompt now explicitly asks for a Title line; parser falls through to a branch-derived conventional-commit title (`fix/cost-tracker` → `fix: cost tracker`), then first summary bullet, then `chore: update` only as a last resort.
- **`runReviewOnTestFail` default flipped to `true`.** Failed/missing test commands no longer silently kill the LLM review phase. Strict gating still available via explicit `false`.

## v5.0.4 — Council Responses API

### Fixed

- **Council 404s on `gpt-5.3-codex` resolved.** Codex variants and o-series reasoning models are Responses-API-only — the council adapter only used `client.chat.completions`. Now branches by model name (`/codex|^o[1-9]|^gpt-5\.3-/`) to use `client.responses.create()` for those models. Fixes the multi-model differentiator for any user with only `OPENAI_API_KEY`.
- **Generic preset ships a working council template.**

## v5.0.3 — Cost tracker

### Fixed

- **Codex adapter computes `costUSD`** (was returning `usage` without a cost field, so every codex run logged $0).
- **`scan` now persists to cost log** (was only `run` writing entries).

## v5.0.2 — Post-install friction

### Fixed

- **preflight `tsx` false-positive eliminated.** Every fresh global install reported `✗ tsx available` blocker because the bundled tsx wasn't checked. Now uses `findPackageRoot(import.meta.url)`.
- **Top-level `unhandledRejection` + `uncaughtException` handlers** format `GuardrailError` as a single-line red message instead of a Node stack trace. `CLAUDE_AUTOPILOT_DEBUG=1` re-enables stack.
- **Tarball trimmed:** dropped `src/` + `*.map` from `files` array → 319 files / 182 kB packed (was 726 / 382 kB), -56% / -52%.
- **Stale strings:** `@alpha` install hint → `@latest`; `npx guardrail run` blocker text → `claude-autopilot run`; init deprecation banner removed (both verbs work).

## v5.0.1 — Types + tombstone

### Fixed

- **Ships `dist/src/index.d.ts`** for TypeScript consumers.
- **Tombstone `@delegance/guardrail` package** publishes a forwarder pointing at the renamed package; pre-rename versions deprecated with migration message.

## v5.2.0 — Migrate skill generalization

### Added

- **Generalized migrate phase** — `migrate@1` (thin orchestrator), `migrate.supabase@1` (rich Delegance runner, paths now parameterized via stack.md), `none@1` (no-op for `--skip-migrate`). Pipeline reads `.autopilot/stack.md` to dispatch the right skill.
- **Auto-detection at init** — `claude-autopilot init` walks the repo, sniffs for Prisma / Drizzle / Rails / Go-migrate / Flyway / dbmate / Alembic / Django / Ecto / TypeORM / Supabase signals, writes a stack.md non-interactively when there's a single high-confidence match. Prompts otherwise.
- **Stack.md schema validation** with security rules: shell metachars rejected in command args, env_file paths confined under project_root, dev_command-as-prod-command blocked.
- **Versioned alias map** (`presets/aliases.lock.json`) with stable IDs (`migrate@1`, `migrate.supabase@1`, `none@1`) so future renames don't break user configs.
- **Skill manifest version handshake** — every skill ships `skill.manifest.json` declaring `skill_runtime_api_version`, `min_runtime`, `max_runtime`. Dispatcher fails closed on incompatibility with explicit upgrade hints.
- **Hash-chained audit log** at `.autopilot/audit.log` (JSONL, monotonic seq + SHA-256 prev_hash chain) for every migrate dispatch. `claude-autopilot doctor` validates the chain.
- **Per-policy enforcement points** — `allow_prod_in_ci`, `require_clean_git`, `require_manual_approval`, `require_dry_run_first`. CI prod migrations require all 4 of: `--yes` flag, `AUTOPILOT_CI_POLICY=allow-prod`, `AUTOPILOT_TARGET_ENV=<env>`, stack.md `policy.allow_prod_in_ci: true`. Plus a recognized CI provider env (or `AUTOPILOT_CI_PROVIDER` override).
- **Structured argv execution** — commands stored as `{ exec, args[] }` and executed via `spawn(shell:false)`. No shell injection vector. Legacy string form deprecated, auto-migrated by `doctor --fix`.
- **`migrate doctor`** with read-only mode (default) and `--fix` mode for safe auto-corrections.
- **Monorepo support** — per-workspace `.autopilot/stack.md` plus root `.autopilot/manifest.yaml` for cross-workspace coordination.
- **Legacy migrate skill migrator** — automatically archives the existing `skills/migrate/` (legacy Delegance Supabase shape) to `skills/migrate.backup-<ISO>/` on `doctor --fix`, replaces with the thin shape.
- **Multi-CI provider detection** — GitHub Actions, GitLab CI, CircleCI, Buildkite, Jenkins recognized out of the box. `AUTOPILOT_CI_PROVIDER` override for self-hosted.
- **Delegance regression CI lane** — required GitHub Actions job that runs the full migrate-supabase flow against an anonymized fixture, asserting byte-for-byte ledger compatibility with pre-dispatcher behavior.

### Changed

- `skills/autopilot/SKILL.md` Step 4 (Migrate) rewritten to describe the envelope-based dispatcher contract instead of invoking `/migrate` directly.

### Backward-compat

- Delegance's existing `npx tsx scripts/supabase/migrate.ts` CLI invocation still works unchanged. The script now ALSO honors the autopilot dispatcher when invoked with `AUTOPILOT_ENVELOPE` + `AUTOPILOT_RESULT_PATH` env vars; falls back to legacy CLI parsing otherwise.
- The old `skills/migrate/` legacy SKILL.md is preserved (and will be auto-archived on first `doctor --fix` post-upgrade).

### Migration guide for existing users

```bash
# Upgrade
npm install -g @delegance/claude-autopilot@5.2.0

# Audit current state (read-only, exits non-zero if migration needed)
claude-autopilot doctor

# Apply auto-fixes (archives legacy /migrate skill, writes new stack.md)
claude-autopilot doctor --fix
```

Existing `npx tsx scripts/supabase/migrate.ts <file> --env dev` workflows are unaffected.

## [5.0.0] — 2026-04-27

First GA release after a five-alpha soak cycle. Promotes `5.0.0-alpha.5` to GA unchanged on the code side; the only diff is the version bump, README rebranding away from `@alpha` channel guidance, and a new "Reproducing the benchmark" section.

### Added
- **README hero benchmark.** Documented 13/13 on the seeded Next.js fixture with Claude Opus at $0.21 / 38s. Includes a "Reproducing the benchmark" section at the bottom with the full procedure, the categories measured, and explicit non-claims (e.g. doesn't measure false-positive rate on clean repos).
- README install instructions now use bare `npm install -g @delegance/claude-autopilot` (no `@alpha` pin) — assumes the `latest` dist-tag has advanced to 5.0.0.

### Changed
- Migration guide install snippets drop the `@alpha` pin and the alpha-cycle warning.
- Removed the alpha-era CLI note from the README ("Alpha.1 CLI note: subcommands are flat …" → just "CLI note").

### Manual GA steps (for the publisher)
After this lands and `v5.0.0` is tagged + auto-published:

1. `cd packages/guardrail-tombstone && npm publish` — publishes `@delegance/guardrail@5.0.0` thin wrapper.
2. `npm dist-tag add @delegance/claude-autopilot@5.0.0 latest` — moves `latest` from the legacy 2.5.0 to GA.
3. `npm deprecate @delegance/claude-autopilot@"<5.0.0" "Pre-rename — use 5.x"` — flags the orphaned 1.0.0-rc.1 / 2.x / 5.0.0-alpha.* releases.
4. `npm deprecate @delegance/guardrail@"<5.0.0" "Renamed — use @delegance/claude-autopilot"` — tells v4 users to migrate (the `5.0.0` tombstone forwards their existing CLI usage transparently).

## [5.0.0-alpha.5] — 2026-04-27

Second hotfix from the soak. Alpha.4 fixed `init`'s preset resolution but `scan` / `run` still crashed on compiled output with `Failed to import adapter from .../auto.ts` — the adapter loader and static-rule registry use dynamic-import string literals that tsc's `rewriteRelativeImportExtensions` doesn't touch.

### Fixed
- **`scan` / `run` adapter loading under compiled JS.** `src/adapters/loader.ts` BUILTIN_PATHS and `src/core/static-rules/registry.ts` import map both used hardcoded `.ts` extensions in dynamic-import string literals. TS's emit-time rewriter only handles static imports, so these strings stayed `.ts` post-compile and the runtime tried to load `dist/.../auto.ts` (which doesn't exist; the file is `auto.js`). New helper `resolveSiblingModule()` in `src/cli/_pkg-root.ts` swaps `.ts` → `.js` based on whether the caller is itself compiled.

### Added
- **Real-world soak benchmark result.** Against a 13-bug seeded Next.js fixture (SQL injection, hardcoded secret, missing auth, IDOR, CORS wildcard, SSRF, open redirect, TOCTOU, silent error swallow, off-by-one, missing rate limit, console.log, no input validation), `claude-autopilot scan --all` with the `claude` adapter caught **13 of 13** with concrete remediation. The cold-start eval reviewer's original run with Llama 3.3 70B caught 8/13 (and even that was blocked by the parser bug now fixed).
- 4 new tests in `tests/pkg-root.test.ts` covering `resolveSiblingModule` semantics across source/.js/.mjs callers, plus a regression test that compiles `dist/` and imports the registry to verify dynamic-import refs resolve.

## [5.0.0-alpha.4] — 2026-04-27

Hotfix discovered by post-publish soak. The previous alpha.3 published a compiled `dist/` bundle but the path-resolution sites that look up `presets/`, `package.json`, etc. assumed source-tree layout (`../..` from `src/cli/<file>.ts` = package root). Under the compiled layout (`dist/src/cli/<file>.js`), the same `../..` resolves to `dist/`, which doesn't contain `presets/` or `package.json`. Result: `npx @delegance/claude-autopilot@alpha init` crashed with "Preset config not found for: generic" — a release-blocker missed by every prior CI check.

### Fixed
- **`init` / `setup` no longer crash on compiled output.** All sites that previously did `path.resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')` now use `findPackageRoot()` from a new shared helper at `src/cli/_pkg-root.ts`. The helper walks up from `import.meta.url` looking for the `@delegance/claude-autopilot` `package.json`, so it lands on the same package root whether the caller is source or compiled.
- Affected sites: `src/cli/setup.ts`, `src/cli/init.ts`, `src/cli/run.ts` (`readToolVersion`), `src/cli/pr-comment.ts` (`readVersion`).

### Added
- `src/cli/_pkg-root.ts` — `findPackageRoot()` and `requirePackageRoot()`.
- `tests/pkg-root.test.ts` — unit test for the helper, plus a full integration smoke that builds `dist/`, invokes `node dist/src/cli/index.js init --preset generic` against a fresh temp project, and asserts `guardrail.config.yaml` is written. Catches future compiled-vs-source path drift.

### Notes for users on alpha.3
- If you ran `npx @delegance/claude-autopilot@alpha init` on alpha.3 and saw "Preset config not found", upgrade with `npm install -g @delegance/claude-autopilot@alpha` to pick up alpha.4. No config changes needed.

## [5.0.0-alpha.3] — 2026-04-24

Final alpha before v5.0.0 GA. Closes every remaining GA blocker from the alpha cycle.

### Added
- **Compiled JS entrypoint** — `npm run build` emits `dist/src/**/*.js` via `tsc -p tsconfig.build.json`. The launcher at `bin/_launcher.js` prefers the compiled output when present (global installs), falls back to `src/` + `tsx` for dev workflows. Drops `tsx` from the runtime hot path for published installs. Uses TypeScript 6's `rewriteRelativeImportExtensions: true` to rewrite `.ts` → `.js` specifiers at emit time; includes a defensive post-build rewriter script that no-ops when tsc already did the work.
- **`claude-autopilot migrate-v4` codemod** — `src/cli/migrate-v4.ts`. Scans a target repo for `@delegance/guardrail` and `guardrail <verb>` references, proposes replacements, applies with `--write` (creates `.v4-backup.<timestamp>` files and writes a restore manifest). `--undo` reads the manifest and restores by sha256 match — refuses to overwrite files modified after the migrate. Covers `package.json` (dependency sections with operator preservation), shell scripts, Makefiles, GitHub Actions yaml, Dockerfiles (including CMD-array `["guardrail", "verb"]` form). Skips `node_modules/`, `dist/`, and the tool's own `.claude-autopilot/` state dir.
- **Tombstone `@delegance/guardrail@5.0.0`** package at `packages/guardrail-tombstone/`. Thin CLI wrapper that forwards argv / stdio / exit code / signal to `@delegance/claude-autopilot`. Resolves the child via `createRequire().resolve()` (works under npm / pnpm / yarn / PnP) with two relative-probe fallbacks and a last-resort PATH lookup. Emits a one-line deprecation notice on stderr (silenceable via `CLAUDE_AUTOPILOT_DEPRECATION=never`). Maps ENOENT to exit 127 with an actionable install hint.
- **CI bin-parity workflow** at `.github/workflows/bin-parity.yml`. On every push to master + PR, runs matrix (ubuntu + macos × node 22 + 24) that packs a tarball, globally installs, then asserts: (a) both bins return semver, (b) deprecation notice is on stderr under `always`, (c) deprecation does not leak onto stdout, (d) exit codes match between `claude-autopilot` and `guardrail` on a non-zero-exit invocation. A second job installs from the published `@alpha` tag on push to master for real-world parity.
- **Prefix-hygiene test** at `tests/no-legacy-prefix.test.ts` — asserts that `src/cli/**` uses `[claude-autopilot]` not `[guardrail]`, with an explicit allowlist for legitimate legacy references (bin wrappers, launcher).
- `tsconfig.build.json` — separate build config with `rewriteRelativeImportExtensions: true` and explicit emit settings.
- `scripts/post-build-rewrite-imports.mjs` — defensive rewriter for `.ts` → `.js` import specifiers in emitted JS. No-op when tsc emits correctly.
- `prepublishOnly` script — runs `build && test` before any `npm publish`.
- 14 new tests (migrate-v4: 7, tombstone-bin: 3, no-legacy-prefix: 1, others: 3).

### Changed
- **Error prefixes normalized** — every `[guardrail] ...` error message in `src/cli/index.ts` and `src/cli/preflight.ts` now uses `[claude-autopilot]` or the phase name (`[run]`, `[doctor]`). Legacy `[guardrail]` retained only in the bin-wrapper deprecation notice, `bin/_launcher.js`, and the tombstone package (where it legitimately refers to the deprecated package name).
- **Welcome screen rewritten** — bare `claude-autopilot` invocation now leads with the pipeline pitch (`claude-autopilot brainstorm "..."`) and frames the review subcommands as the v4-compatible alternative. Previously sold the package as "LLM code review."
- **Version resolution in `src/cli/index.ts`** — walks up from `import.meta.url` for the nearest `@delegance/claude-autopilot` `package.json` instead of a hardcoded `../../package.json`. Necessary because the compiled entrypoint lives at `dist/src/cli/index.js` where the old relative path resolved to `dist/package.json` (which doesn't exist).
- **`package.json` `files` field** now includes `dist/` (new) and `scripts/post-build-rewrite-imports.mjs`.
- `preflight.ts`: "Guardrail prerequisite check" heading → "claude-autopilot prerequisite check".

### Fixed
- (None — alpha.3 is feature work; no regressions surfaced by the compat matrix.)

### Still manual for GA
- Alex to publish `@delegance/guardrail@5.0.0` tombstone from `packages/guardrail-tombstone/`.
- Alex to run `npm dist-tag add @delegance/claude-autopilot@5.0.0 latest` once 5.0.0 GA ships.
- Alex to run `npm deprecate @delegance/claude-autopilot@"<5.0.0" "Use @delegance/claude-autopilot@alpha during alpha cycle, or @latest after GA"` to flag pre-rename versions.

## [5.0.0-alpha.2] — 2026-04-24

### Added
- **v4 compatibility assertion matrix** at `tests/v4-compat/` — 20 pinned invocations covering version/help, subcommand routing for all v4 names, deterministic reads (doctor, costs, baseline, explain), flag parsing (`--base`, `--format`, `--fail-on`), deprecation-notice behavior, and the new grouped verbs. Uses marker/regex assertions, not full stdout snapshots — still catches routing and parsing regressions, which is the intent. Full normalized-stdout snapshots for deterministic commands are a follow-up item. Regression of any test blocks future alpha promotion.
- **Superpowers peer-dep detection** — `doctor` now reports a warn-level check for `superpowers:writing-plans`, `superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`. Missing skills produce an actionable remediation hint (`claude plugin install superpowers`). Treated as warn not fail because review-only users don't need it; pipeline phases will hard-fail at their own entry point.
- **Grouped CLI verbs (phase 1: additive aliases)** — `claude-autopilot review <verb>` accepts `{run, scan, ci, fix, baseline, explain, watch, report}`. `claude-autopilot advanced <verb>` accepts `{lsp, mcp, worker, autoregress, test-gen, hook, detector, ignore}`. Both are additive aliases — flat forms (`claude-autopilot run`) continue to work unchanged. Broader restructuring (pipeline verbs `migrate`/`validate` top-level, `pr {create,comment,desc}`) is a later-alpha item.
- **`peerDependencies.superpowers`** (optional) declared in `package.json`.
- `src/cli/preflight.ts`: `findMissingSuperpowersSkills()` exported with recursive search across `~/.claude/plugins/**` and project-local `.claude/plugins/**`.

### Fixed
- **`--help` / `-h` routed to `run`** (latent v4 bug). v4's dispatcher defaulted the subcommand to `run` when `args[0]` started with `--`, so `guardrail --help` silently executed a review instead of printing help. v5.0.0-alpha.2 intercepts `--help`/`-h` before subcommand defaulting and routes to the help handler. Surfaced by the new v4 compat matrix.
- **`--help` output missing 8 v4 subcommands** — `setup`, `preflight`, `hook`, `baseline`, `triage`, `pr-desc`, `council`, `mcp` were listed in the `SUBCOMMANDS` array but not in `printUsage()`. Help now lists all 20+.

### Changed
- README install instructions now pin `@alpha` explicitly for the v5 alpha cycle. The npm `latest` tag still points at a pre-rename 2.5.0 release; without pinning, bare installs silently regress to old code. When 5.0.0 GA ships, `latest` advances and the `@alpha` pin becomes optional.
- Migration guide updated with the `@alpha` pinning note for `npm install`, GitHub Actions, and Dockerfile examples.

### Still deferred to alpha.3
- Tombstone `@delegance/guardrail@5.0.0` with thin CLI wrapper and strict argv/stdio passthrough.
- CI bin-parity smoke tests (`npx guardrail`, `npx @delegance/guardrail`, global install, GitHub Actions).
- Codemod script `claude-autopilot migrate-v4 [--write]`.
- Compiled JS entrypoint (drops `tsx` runtime dep).

## [5.0.0-alpha.1] — 2026-04-24

**Package renamed: `@delegance/guardrail` → `@delegance/claude-autopilot`.**

The v4 product sold itself as "LLM code review." The real product is an end-to-end autonomous development pipeline built on Claude Code skills — brainstorm → spec → plan → implement → migrate → validate → PR → review → merge. This alpha corrects the identity mismatch without breaking any v4 usage.

Every v4 invocation continues to work through v5.x via the preserved `guardrail` CLI alias. Migration guide: `docs/migration/v4-to-v5.md`.

### Added
- **`claude-autopilot` CLI binary** — primary entrypoint (`bin/claude-autopilot.js`), co-installed with `guardrail`.
- **Pipeline skills bundled in the tarball** — `skills/claude-autopilot.md` (agent-loop spec), `skills/autopilot/`, `skills/migrate/`. v4.3.1 shipped only `skills/guardrail.md`; the pipeline skills existed only in-repo and weren't distributed.
- **`generic` preset** — no DB migration runner, uses `npm test` / `npm run typecheck` / `npm run lint` where present. Picked by `detectProject()` as the fallback when no stack signals are found (replaces the v4 behavior of claiming `nextjs-supabase` with low confidence).
- **v5 migration guide at `docs/migration/v4-to-v5.md`** — find/replace patterns for `package.json`, shell scripts, GitHub Actions yaml, Dockerfiles, and Claude Code skills.

### Changed
- **Stack detector fallback:** plain Next.js with no Supabase signals now returns `generic`, not `nextjs-supabase (low confidence)`. Fixes the cold-start eval reviewer finding.
- **`PRESET_LABELS` in `setup.ts`:** adds `generic` entry.
- **Detector tests:** updated to assert the new `generic` fallback behavior.
- **`skills/guardrail.md`:** rewritten as a back-compat alias pointing at `skills/claude-autopilot.md`.
- **`bin/guardrail.js`:** emits a one-line deprecation notice on `stderr` on first invocation per terminal session, then forwards unchanged.

### Deferred to later alphas
- **alpha.2:** full CLI verb restructure (`claude-autopilot {review,pr,triage,advanced,…}`), v4 compatibility golden-test matrix, superpowers peer-dep hard-fail in `doctor`.
- **alpha.3:** tombstone `@delegance/guardrail@5.0.0` publish, CI smoke tests for `npx guardrail` / `npx @delegance/guardrail` / global install / GitHub Actions parity, codemod script for find/replace migration.
- **5.0.0 GA:** after alpha.3 soaks against delegance-app for 2+ real feature pipelines.

## [4.3.1] — 2026-04-24

### Fixed (from external cold-start review)
- **`parseReviewOutput` silent failure** — regex required literal `### [CRITICAL]` brackets and returned zero findings when the LLM emitted `### CRITICAL`, `### **CRITICAL**`, or `### **[CRITICAL]**` (all common Llama/GPT variants). `src/adapters/review-engine/parse-output.ts` now accepts all four formats and logs a warning when raw output is non-empty but no findings parse, so format drift never silently hides bugs again.
- **Pipeline short-circuit skipped LLM review** — `src/core/pipeline/run.ts` returned early on static-rules `fail`, meaning the LLM never ran on the code that most needed it (IDOR, TOCTOU, CORS, off-by-one, rate-limit gaps typically ride alongside a static-flagged issue). New default: review runs even on static-fail. Legacy behavior restored via `pipeline.runReviewOnStaticFail: false` in config.
- **`doctor` / `preflight` ignored 3 of 5 LLM keys** — only checked `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, so users with `GROQ_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY` set saw "No LLM API key" right after `setup` reported "detected." New shared helper `src/core/detect/llm-key.ts` is the single source of truth used by setup, scan, run, and preflight.
- **Stack detector mislabeled plain Next.js as "Next.js + Supabase"** — now requires actual Supabase signals (`@supabase/supabase-js`, `@supabase/ssr`, `@supabase/auth-helpers-nextjs`, `supabase/config.toml`, or `SUPABASE_*` env vars). Vanilla Next.js still uses the `nextjs-supabase` preset as a fallback but the evidence string and setup output make the fallback explicit.
- **`--profile team` missing security rules** — added `package-lock-sync`, `ssrf`, `insecure-redirect` to match the README's advertised coverage.

### Added
- `src/core/detect/llm-key.ts` — `detectLLMKey()`, `LLM_KEY_NAMES`, `LLM_KEY_HINTS`, `loadEnvFile()`.
- `GuardrailConfig.pipeline.runReviewOnStaticFail` / `runReviewOnTestFail` config flags.
- 6 parser format-variation tests covering all documented markdown variants plus the silent-drift warning path.

## [2.5.0] — 2026-04-22

### Added
- **Config schema validation** — `ignore:` and `reviewStrategy: diff|auto-diff` now accepted; unknown keys reported as `unexpected key "<name>"`; enum errors list allowed values; error message includes up to 5 violations with field paths
- **`autopilot fix`** — reads `.autopilot-cache/findings.json`, asks the configured LLM to rewrite the ±20 lines around each finding, applies patches in place; `--severity critical|warning|all` (default: critical); `--dry-run` previews without writing; exits 1 if any fix fails
- **`autopilot costs`** — prints all-time run count + spend, 7-day summary, and a last-10-runs table (date, files, tokens in/out, cost, duration)
- `src/cli/fix.ts` — `runFix()`; sends numbered context window to LLM with fix instructions; strips markdown fences from response; handles `CANNOT_FIX` sentinel gracefully
- `src/cli/costs.ts` — `runCosts()` reading `.autopilot-cache/costs.jsonl`
- 9 new tests — **266 total**

## [2.4.0] — 2026-04-22

### Added
- **`ignore:` config key** — embed suppression rules in `autopilot.config.yaml` via `ignore: ['tests/**', { rule: hardcoded-secrets, path: src/vendor/** }]`; merged with `.autopilot-ignore` file rules at run time
- **Per-run cost log** — appends `{timestamp, files, inputTokens, outputTokens, costUSD, durationMs}` to `.autopilot-cache/costs.jsonl` after every run; corrupt lines skipped on read; `readCostLog()` exported for tooling
- **`--inline-comments`** — posts a GitHub PR review with per-line inline comments for every finding that has a `file:line`; re-runs dismiss the previous autopilot review before posting a new one; `autopilot ci` enables this by default (`--no-inline-comments` to opt out)
- **`reviewStrategy: auto-diff`** — tries diff first, falls back to full-file `auto` when diff is empty (new files, no git history); `--diff` flag still forces pure diff mode
- `src/cli/pr-review-comments.ts` — `postReviewComments()` using `gh api repos/{nwo}/pulls/{pr}/reviews`
- `src/core/persist/cost-log.ts` — `appendCostLog()`, `readCostLog()`
- 9 new tests — **257 total**

## [2.3.0] — 2026-04-22

### Added
- **Parallel chunk review** — file-level chunks are now reviewed concurrently (default parallelism: 3, configurable via `chunking.parallelism`); serial fallback preserved when `cost.budgetUSD` is set so budget enforcement remains accurate
- **`.autopilot-ignore`** — project-level suppression file; format: `<rule-id> <glob>` or bare `<glob>` (matches any finding on that path); comments and blank lines ignored; suppressed count printed dim after run
- **`--delta` mode** — only reports findings new since the previous run; pre-existing findings are hidden and the count is printed dim; findings always persisted to `.autopilot-cache/findings.json` after each run (gitignored)
- `src/core/ignore/index.ts` — `loadIgnoreRules()`, `applyIgnoreRules()`
- `src/core/persist/findings-cache.ts` — `loadCachedFindings()`, `saveCachedFindings()`, `filterNewFindings()`
- 15 new tests — **248 total**

## [2.2.0] — 2026-04-22

### Added
- **`reviewStrategy: diff`** — new chunking strategy that sends `git diff` unified hunks instead of full file contents; typically ~70% fewer tokens and more focused findings (LLM sees exactly what changed)
- **`--diff` flag** on `run` and `ci` subcommands — shorthand to activate diff strategy without editing config
- **`src/core/git/diff-hunks.ts`** — `getFileDiffs()`, `parseUnifiedDiff()`, `formatDiffContent()`; per-file diff sections in fenced code blocks; files that exceed `maxChars` are omitted with a count notice
- `BuildChunksInput.base` / `ReviewPhaseInput.base` / `RunInput.base` — threads git base ref through pipeline to diff engine
- 9 new tests for `parseUnifiedDiff` and `formatDiffContent` — **233 total**

## [2.1.0] — 2026-04-22

### Added
- **Risk-weighted file ordering** (`src/core/chunking/risk-ranker.ts`) — ranks files before sending to LLM: protected paths (score 100) → auth/security (80) → payment/billing (70) → core logic (50) → config files (40) → everything else (30) → tests (10) → docs (5); ensures most sensitive code appears at the start of the LLM's context window
- `BuildChunksInput.protectedPaths` — passed from config through review-phase to ranker so glob patterns from `protectedPaths:` config key are respected
- 9 new tests for `rankByRisk` — **224 total**

## [2.0.0] — 2026-04-22

### Added
- **`autopilot ci`** — opinionated single-command CI entrypoint; defaults to `--post-comments`, `--format sarif`, and base ref from `GITHUB_BASE_REF`/`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`/`HEAD~1`; supports `--base`, `--output`, `--no-post-comments`
- **`.github/actions/ci/action.yml`** — composite GitHub Actions action; accepts `anthropic-api-key`, `openai-api-key`, `gemini-api-key`, `groq-api-key`, `base-ref`, `config`, `sarif-output`, `post-comments` inputs; runs `npx autopilot ci`, uploads SARIF via `codeql-action/upload-sarif@v3`
- **Updated `skills/autopilot.md`** — complete rewrite covering all adapters, auto-detection, `--post-comments`, `ci` command, action.yml usage

## [1.9.0] — 2026-04-22

### Added
- **`--post-comments` flag on `run`** — posts a formatted markdown summary to the open PR after the pipeline; edits existing autopilot comment on re-runs instead of creating a new one (tracked via `<!-- autopilot-review -->` marker)
- **`detectPrNumber()`** — reads `PR_NUMBER`/`GH_PR_NUMBER`/`GITHUB_PR_NUMBER` env vars (CI) or falls back to `gh pr view` (local)
- **`formatComment()`** — status badge, context line, phase table, critical/warning findings with `file:line`, notes in `<details>`, cost footer
- 10 new formatter tests — **215 total**

## [1.8.0] — 2026-04-22

### Added
- **Shared `parseReviewOutput()`** (`src/adapters/review-engine/parse-output.ts`) — extracts `file:line` attribution from review finding bodies; used by all five adapters; eliminates ~100 lines of duplicated parser code

### Fixed
- `hardcoded-secrets` false positive on route object keys containing `password` (e.g. `forgot_password: '/forgot-password'`)

## [1.7.2] — 2026-04-22

### Fixed
- `hardcoded-secrets` rule no longer fires on route path values (values starting with `/`)

## [1.7.1] — 2026-04-22

### Added
- Detection logging: `auto-detected:` line in run output shows stack, protected paths, and test command when inferred; git context (branch + last commit) shown on every run

## [1.7.0] — 2026-04-22

### Added
- **Stack auto-detection** (`src/core/detect/stack.ts`) — infers human-readable stack string from `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, `Gemfile`; detects framework, ORM, auth, UI library, language; injected into review prompt automatically when `stack:` is absent from config
- **Protected-paths auto-detection** (`src/core/detect/protected-paths.ts`) — scans for migration dirs (`data/deltas/`, `migrations/`, `db/migrate/`, `prisma/migrations/`, `alembic/versions/`, `flyway/`), schema files (`schema.prisma`, `schema.sql`, `db/schema.rb`), infra dirs (`terraform/`, `k8s/`, `helm/`, `.github/workflows/`); populates `protectedPaths` when not set in config
- **Test-command runtime fallback** — re-runs project detector at `run` time when `testCommand` is absent from config; `null` still disables the test phase explicitly
- **Git context enrichment** (`src/core/detect/git-context.ts`) — injects branch name and last commit message into the review prompt as `Change context: branch: feat/x | last commit: add user auth` so the LLM understands intent
- `ReviewInput.context.gitSummary` — new context field; all five adapters (claude, gemini, codex, openai-compatible, auto) inject it when present
- 18 new tests (9 stack + 9 protected-paths) — **199 total**

## [1.6.0] — 2026-04-22

### Added
- **Provider usage scanner** (`src/core/detect/provider-usage.ts`) — walks project source files, counts per-provider API key and SDK references (capped at 1 per file to avoid skew), returns `ProviderCounts`
- **`dominantProvider()`** — returns the provider with the highest file-reference count
- **Smart `auto` tiebreaker** — when multiple API keys are present, `auto` scans the codebase and prefers the provider already used there; falls back to env-key priority order if counts are all zero
- `ReviewInput.context.cwd` — threads working directory through to the review engine so `auto` knows where to scan; `review-phase.ts` now passes `cwd` in context
- 12 new tests for `detectProviderUsage` and `dominantProvider` — **181 total**

## [1.5.0] — 2026-04-22

### Added
- **Gemini adapter** (`gemini`) — Google Gemini 2.5 Pro via `@google/generative-ai`; accepts `GEMINI_API_KEY` or `GOOGLE_API_KEY`; 1M token context window
- **OpenAI-compatible adapter** (`openai-compatible`) — works with any OpenAI-API-compatible endpoint (Groq, Ollama, Together AI, etc.); requires `options.model`; auto-selects API key via `options.apiKeyEnv` → `OPENAI_API_KEY` → `'ollama'`
- **Updated auto adapter** — full priority chain: `ANTHROPIC_API_KEY` → `GEMINI_API_KEY`/`GOOGLE_API_KEY` → `OPENAI_API_KEY` → `GROQ_API_KEY` (wraps openai-compatible with Groq config)
- `run.ts` no-key warning now lists all four key options

### Changed
- 169 tests total (up from 136)

## [1.4.0] — 2026-04-21

### Added
- **Static rules registry** (`src/core/static-rules/registry.ts`) — lazy-loads built-in rules by name; fixes critical bug where config `staticRules` was always silently ignored
- **7 built-in rules**: `hardcoded-secrets`, `npm-audit`, `package-lock-sync`, `console-log`, `todo-fixme`, `large-file`, `missing-tests`
- **Claude adapter** (`claude`) — Anthropic Claude Opus 4.7 via `@anthropic-ai/sdk`; configurable model via `context.model`
- **Auto adapter** (`auto`) — detects best available key at runtime; checked in priority order
- `doctor` now checks `ANTHROPIC_API_KEY` in addition to `OPENAI_API_KEY`
- 136 tests total

### Fixed
- **Critical**: `staticRules` in `RunInput` was never populated — config-listed rules were silently ignored. `loadRulesFromConfig()` now wired into `run.ts`

## [1.2.8] — 2026-04-21

### Added
- 8 new tests covering npm placeholder detection, pyproject.toml FastAPI detection, `resolveGitTouchedFiles` ignore list, deduplication, and status fallback — **136 total**

## [1.2.7] — 2026-04-21

### Fixed
- `autopilot run` now loads `.env.local` / `.env` at startup so `OPENAI_API_KEY` (and other env vars) are available without exporting them in the shell first

## [1.2.6] — 2026-04-21

### Added
- `skills/autopilot.md` included in npm package — install once, then `cp node_modules/@delegance/claude-autopilot/skills/autopilot.md .claude/skills/` to give Claude Code full context on when and how to invoke the CLI

## [1.2.5] — 2026-04-21

### Added
- `--version` / `-v` flag — prints package version and exits
- Built-in ignore list for git diff output: `node_modules/`, `dist/`, `build/`, `.next/`, `.nuxt/`, `out/`, `coverage/`, `.turbo/`, `.cache/`, `vendor/`, `__pycache__/`, `.venv/`, `venv/`, `target/`, `.gradle/` — prevents build artifact floods from polluting the changed-files list

## [1.2.4] — 2026-04-21

### Changed
- `autopilot init` is now deprecated — prints a notice and delegates to `autopilot setup`

### Fixed
- Removed superpowers plugin check from `doctor` — it was warning all external developers about a Delegance-internal tool they cannot install

## [1.2.3] — 2026-04-21

### Fixed
- README rewrite: `setup` and `doctor` commands now prominent; config schema accurate; public API section added

## [1.2.2] — 2026-04-21

### Fixed
- Hook install called from `setup` no longer double-prints stderr; added `silent` option to `runHook()` to suppress output when invoked programmatically

## [1.2.1] — 2026-04-21

### Fixed
- `bin/autopilot.js` tsx resolution now checks the consumer's `node_modules/.bin/tsx` before falling back to PATH — fixes "tsx not found" on fresh installs
- npm default test placeholder (`echo "Error: no test specified" && exit 1`) is now detected and replaced with `npm test` instead of being used as the test command

## [1.2.0] — 2026-04-21

### Added
- `autopilot doctor` — prerequisite checker: verifies Node 22+, tsx, gh CLI auth, claude CLI, OPENAI_API_KEY, git config, superpowers plugin; shows exact fix command for each failure; exits 1 if any blockers
- `autopilot setup` now runs `doctor` automatically at the end so users immediately see what still needs attention
- `autopilot preflight` kept as alias for `doctor`

## [1.1.0] — 2026-04-21

### Added
- `autopilot setup` — zero-prompt setup: auto-detects project type (Go, Rails, FastAPI, T3, Next.js+Supabase), infers test command, writes config, installs git hook in one command
- `autopilot setup --force` — overwrite existing config

## [1.0.2] — 2026-04-21

### Fixed
- README: install command updated (`--save-dev` removed, `@alpha` tag removed); hard prerequisites documented
- preflight: tsx missing message no longer suggests `--save-dev` (tsx is now a runtime dependency)

## [1.0.1] — 2026-04-21

### Fixed
- Move `tsx`, `js-yaml`, `ajv`, `dotenv`, `minimatch`, `openai` from `devDependencies` to `dependencies` — CLI was broken for end-users who installed via npm since devDeps aren't installed by consumers

## [1.0.0] — 2026-04-21

### Changed
- Promoted from 1.0.0-rc.1 — no new changes, stable release

## [1.0.0-rc.1] — 2026-04-21

### Added
- `autopilot init` now shows full next-steps: hook install, autoregress generate, CI snippet, first run
- Public API surface: `Finding`, `RunResult`, `AutopilotConfig`, `normalizeSnapshot` exported from package root via `exports` field in package.json

### Changed
- Version promoted from 1.0.0-alpha.8 → 1.0.0-rc.1

## 1.0.0-alpha.8

### Added

- **`autopilot autoregress`** — `autoregress run|diff|update|generate` now a first-class `autopilot` subcommand (no more raw `npx tsx scripts/autoregress.ts`)
- **GitHub Actions CI** — `.github/workflows/ci.yml` runs typecheck + tests on every PR; auto-publishes to npm on `v*` tags
- **README rewrite** — full feature documentation covering all alphas (all commands, config, GitHub Actions, snapshot regression, architecture)

## 1.0.0-alpha.7

### Added

- **`autopilot hook install`** — writes a `pre-push` git hook that runs `autoregress run` before every push; `hook uninstall` removes it; `hook status` shows current state; `--force` overwrites existing hook
- **`autoregress diff`** — colored snapshot viewer showing line-by-line JSON diffs between current output and baselines; exits 1 if any diffs found (never modifies baselines — use `update` for that)
- **`autoregress generate --files <list>`** — explicit comma-separated file list bypasses git detection; generates baselines for any src file on demand
- **Real baselines** — `tests/snapshots/*.snap.ts` + baselines for `serializer.ts`, `import-scanner.ts`, `impact-selector.ts`, and `sarif.ts` — alpha.6 infrastructure now self-testing via snapshots

## 1.0.0-alpha.6

### Added

- **Auto-regression testing** (`scripts/autoregress.ts generate|run|update`) — autoresearch-inspired snapshot tests for changed source modules
- **Impact-aware selection** — only fires snapshots whose source modules (or one-hop importers) were touched; high-impact paths (`src/core/pipeline/**`, `src/adapters/**`, `src/core/findings/**`, `src/core/config/**`) and >10-file changes trigger full run
- **Snapshot serializer** (`src/snapshots/serializer.ts`) — deterministic JSON normalization: sorted keys, `<timestamp>`, `<uuid>`, path stripping
- **Import scanner** (`src/snapshots/import-scanner.ts`) — static `import`/`export` graph → reverse dependency map
- **Impact selector** (`src/snapshots/impact-selector.ts`) — merge-base diff + one-hop expansion + overrides
- **Baseline capture** — `CAPTURE_BASELINE=1` env flag; `autoregress update` rewrites baselines after intentional changes
- **Staleness detection** — warns and skips snapshots whose `@snapshot-for` source file no longer exists
- 10 new unit tests (AR1-AR10) for serializer, import scanner, and impact selector

## 1.0.0-alpha.5 (2026-04-21)

### New Features

- **`--format sarif --output <path>`** on `autopilot run` — serialises `RunResult` to SARIF 2.1.0; deduplicates rules by category; normalises URIs to repo-relative forward-slash; always emits `results: []` even on error so `upload-sarif` never fails on a missing file
- **Auto GitHub Actions annotations** — when `GITHUB_ACTIONS=true`, `emitAnnotations()` fires after every run and writes `::error`/`::warning`/`::notice` workflow commands to stdout; GitHub renders these as inline annotations on the PR diff
- **`src/formatters/`** — pure formatter modules (`sarif.ts`, `github-annotations.ts`) with full command-injection encoding (`%`, `\r`, `\n`, `:`, `,`) for annotation properties and data
- **`action.yml`** composite action — checkout → setup-node@v4 → npx autopilot run → upload-sarif@v3; inputs: `version`, `config`, `sarif-output`, `openai-api-key`; upload step runs `if: always()` so findings surface even when run exits 1
- 21 new formatter tests (11 SARIF + 10 annotations) → **95 total**

## 1.0.0-alpha.4 (2026-04-21)

### New Features

- **`autopilot watch`** (`src/cli/watch.ts`) — watches cwd recursively, debounces file changes (default 300ms), re-runs `runAutopilot()` on each batch, prints phase summary per run; Ctrl+C exits cleanly
- **`--debounce <ms>`** flag on `watch` subcommand
- **`makeDebouncer`** and **`isIgnored`** exported as pure functions (testable without real watcher)
- **`files` field** in package.json — excludes tests, restricts publish to `bin/`, `src/`, `presets/`, `scripts/test-runner.mjs`, `CHANGELOG.md`
- **`private: true` removed** — package is now publishable to npm
- **`engines.node: >=22.0.0`**, `keywords`, `license`, `repository` added to package.json
- 12 new watch tests (7 isIgnored + 5 debouncer) → 74 total

## 1.0.0-alpha.3 (2026-04-21)

### New Features

- **`autopilot run`** (`src/cli/run.ts`) — runs the full pipeline from the terminal: loads config, resolves preset, auto-detects changed files via git diff, calls `runAutopilot()`, prints phase summary with inline finding details
- **`autopilot init`** (`src/cli/init.ts`) — interactive preset scaffold: lists 5 presets, writes `autopilot.config.yaml`, prints next steps
- **`autopilot preflight`** — re-routes to existing preflight checker
- **Git touched-files resolver** (`src/core/git/touched-files.ts`) — `resolveGitTouchedFiles()` diffs HEAD~1..HEAD, falls back to `git status` for single-commit repos; configurable `--base` ref
- **CLI entrypoint** (`src/cli/index.ts`) — dispatches to init/run/preflight subcommands; supports `--base`, `--config`, `--files`, `--dry-run` flags
- **`bin.autopilot`** restored in `package.json` pointing at the new entrypoint
- 10 new CLI tests (5 touched-files, 5 run-command) → 62 total

## 1.0.0-alpha.2 (2026-04-20)

### New Features

- **Run pipeline orchestrator** (`src/core/pipeline/run.ts`) — top-level `runAutopilot()` sequences static-rules → tests → review phases with fail-fast semantics and cost accumulation
- **2-tier chunking** (`src/core/chunking/`) — `auto` strategy selects single-pass (≤8K tokens) or file-level (≤60K); `single-pass` and `file-level` strategies configurable via `reviewStrategy`
- **Cost visibility** — `costUSD` accumulated across review phase, surfaced in `RunResult.totalCostUSD`; optional `cost.budgetUSD` threshold emits warning and skips remaining chunks when exceeded
- **Review-engine response cache** (`src/core/cache/`) — file-based SHA-256 cache with configurable TTL; `withCache()` wraps any `ReviewEngine`; atomic writes (tmp+rename)
- **4 new presets** — `t3` (Next.js + tRPC + Prisma), `rails-postgres`, `python-fastapi`, `go`; each ships a stack.md and at least one stack-specific static rule
- **20 scenario tests** (`tests/scenarios/run-pipeline.test.ts`) — covers fail-fast, autofix, budget, chunking strategies, preset loading

### Fixes

- `finalize()` now trusts per-phase status (which accounts for autofixes) instead of re-deriving from raw `allFindings` severity
- Test script glob changed to `find tests -name '*.test.ts' | xargs` to pick up nested scenario tests

## 1.0.0-alpha.1 (2026-04-20)

Initial release — core infrastructure: adapter interfaces, config system, preflight CLI, static-rules phase with autofix, tests phase, Codex/GitHub/Supabase/Cursor adapters, nextjs-supabase preset, 32 unit tests.
