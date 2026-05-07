# v5.x → v6 Migration Guide

**Audience:** existing claude-autopilot users (v5.x) who want to start using the v6 Run State Engine on their next run.

**TL;DR.** v6 is a **superset** of v5.x. Every existing CLI verb keeps its current behavior. As of **v6.1**, the Run State Engine is **on by default** — every invocation gets persistent run state, resumable phases, hard budget caps, and a typed JSON event stream. v6.0 shipped it OFF for a stabilization window; v6.1 flips the default once that window closed. Users who want the old (engine-off) shape can opt out for one minor version via `--no-engine` / `CLAUDE_AUTOPILOT_ENGINE=off` / `engine.enabled: false` — that escape hatch is removed in v7.

---

## Migrating from v6.0 to v6.1

If you're already on v6.0, this is a small change.

**What flipped.** The built-in default for `engine.enabled` flipped from `false` (v6.0) to `true` (v6.1+). Everything else — the precedence matrix, the events shape, the `runs *` CLI surface, budget config — is unchanged.

**Practical effect.**

- **You opted in via config (`engine.enabled: true`).** No-op. Your config still wins via the same precedence rules.
- **You opted in via CLI / env (`--engine` / `CLAUDE_AUTOPILOT_ENGINE=on`).** No-op. Those still win and the result is the same.
- **You did nothing (relied on the default).** v6.1 now creates a `.guardrail-cache/runs/<ulid>/` dir on every invocation, emits NDJSON events on stderr, and applies budget gates if `budgets:` is configured. If your CI parses stderr as free-form text, the new event lines may need a filter — see [strict --json mode](#strict-json-mode) below for the channel discipline contract.

**Keeping v6.0 (engine-off) behavior temporarily.** Three equivalent ways, in precedence order:

```bash
# CLI flag (per invocation)
claude-autopilot scan --no-engine src/

# Env var (process-wide)
export CLAUDE_AUTOPILOT_ENGINE=off

# Config (project-wide)
# guardrail.config.yaml
engine:
  enabled: false
```

**Heads up — these are deprecated as of v6.1.** Each one prints a one-line stderr notice on every invocation:

```
[deprecation] --no-engine / engine.enabled: false will be removed in v7. Migrate to engine-on (default).
```

**v7 removes the escape hatch.** After v7, `engine.enabled: false` is a config-validation error and `--no-engine` / `CLAUDE_AUTOPILOT_ENGINE=off` are silently ignored (the engine is the only mode). The deprecation notice in v6.1 is your one minor version of warning. Plan to remove any explicit `engine.enabled: false` from your config before bumping to v7.

---

## v6.1 → v6.2: one runId across the pipeline

If your CI / shell script today looks like:

```bash
claude-autopilot scan
claude-autopilot spec
claude-autopilot plan
claude-autopilot implement
claude-autopilot migrate
claude-autopilot pr
```

each invocation creates its own runId. Your `$25` budget cap applies per phase, not per pipeline. A failure in `implement` leaves three orphan run dirs and your `runs watch` window only ever shows one phase at a time.

Replace with:

```bash
claude-autopilot autopilot --mode full --budget 25
```

**One runId across all six phases.** `runs watch <id>` shows the full pipeline ticking down a single budget. Resume from a mid-pipeline failure short-circuits the completed phases via their persisted `phase.success` events — no re-running of `scan`/`spec`/`plan` after an `implement` crash.

**Phase set caveat.** v6.2.0 shipped `--mode=full` as a 4-phase pipeline (`scan → spec → plan → implement`); v6.2.1 added the side-effect idempotency contracts that gate `migrate` and `pr` and extended `--mode=full` to the full **6-phase** flow `scan → spec → plan → implement → migrate → pr`. The `runs watch` and `--json` envelope examples in the rest of these docs assume the v6.2.1 phase set. If you're pinned to v6.2.0, drop `migrate` and `pr` from your mental model.

**Per-verb invocations continue to work.** v6.2 does NOT deprecate them. The orchestrator is sugar — its phases are the same builders the per-verb commands use, wired together through `runPhaseWithLifecycle`. Mixed pipelines (`autopilot --phases=scan,spec,plan` plus a manually-driven `implement`) work too.

### `--json` envelope (v6.2.2+)

```bash
claude-autopilot autopilot --mode full --budget 25 --json
```

Stdout receives **exactly one** envelope on completion (success OR failure):

```json
{"version":"1","verb":"autopilot","runId":"01HQK8...","status":"success","exitCode":0,"phases":[{"name":"scan","status":"success","costUSD":0.42,"durationMs":12340},{"name":"spec","status":"success","costUSD":1.10,"durationMs":18200},{"name":"plan","status":"success","costUSD":0.85,"durationMs":14500},{"name":"implement","status":"success","costUSD":1.10,"durationMs":22000},{"name":"migrate","status":"success","costUSD":0,"durationMs":4200},{"name":"pr","status":"success","costUSD":0,"durationMs":3100}],"totalCostUSD":3.47,"durationMs":74440}
```

Pre-run failures (engine off, unknown phase) ALSO emit a single envelope on stdout — `runId: null`, `phases: []`, `errorCode: 'invalid_config'`:

```json
{"version":"1","verb":"autopilot","runId":null,"status":"failed","exitCode":1,"phases":[],"totalCostUSD":0,"durationMs":12,"errorCode":"invalid_config","errorMessage":"engine disabled via CLAUDE_AUTOPILOT_ENGINE=off; autopilot requires engine-on"}
```

Mid-pipeline failures carry `failedAtPhase` + `failedPhaseName`:

```json
{"version":"1","verb":"autopilot","runId":"01HQK9...","status":"failed","exitCode":78,"phases":[{"name":"scan","status":"success","costUSD":0.42,"durationMs":12340},{"name":"spec","status":"success","costUSD":1.10,"durationMs":18200},{"name":"plan","status":"failed","costUSD":0.85,"durationMs":14500}],"totalCostUSD":2.37,"durationMs":45040,"errorCode":"budget_exceeded","errorMessage":"phase \"plan\" exceeded run budget $2.50","failedAtPhase":2,"failedPhaseName":"plan"}
```

The `errorCode` field uses a bounded enum — CI consumers can safely branch on these specific strings:

| `errorCode` | Meaning | Exit code |
|---|---|---|
| `invalid_config` | pre-run validation, `--phases` parse, engine off | `1` |
| `budget_exceeded` | run-scope budget cap hit | `78` |
| `lock_held` | engine lock collision (another run owns the cache) | `2` |
| `corrupted_state` | `state.json` mismatch / schemaVersion out of range | `2` |
| `partial_write` | `events.ndjson` torn write | `2` |
| `needs_human` | interactive prompt would fire in `--json` | `78` |
| `phase_failed` | generic phase failure (LLM error, network, …) | `1` |
| `internal_error` | catch-all for the uncaughtException handler | `1` |

NDJSON events continue to flow to stderr unchanged — the envelope is a stdout-only artifact, so existing `events.ndjson` consumers see no behavior change.

### Cache contract version policy (v6.2.2+)

Run dirs at `.guardrail-cache/runs/<ulid>/` carry a `schema_version` on every event. v6.2.2 enforces a min/max compatibility window when replaying state:

- `RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION = 1` — lowest version this binary can replay.
- `RUN_STATE_MAX_SUPPORTED_SCHEMA_VERSION` — equal to the writer's `RUN_STATE_SCHEMA_VERSION` (current: `1`).

A run dir whose `schema_version` is outside that window throws `corrupted_state` with a message naming both bounds: "this binary supports schema_version 1..1; use the version of claude-autopilot that created this run dir, or delete the run dir to start fresh." Future minor versions can additively expand the schema while preserving forward-read compatibility — bump `RUN_STATE_SCHEMA_VERSION` (writer) without bumping `MIN_SUPPORTED` (reader). Major bumps (v7) reset `MIN_SUPPORTED` to break with the past explicitly.

If you keep long-lived run dirs across `claude-autopilot` upgrades, the message is your signal to either pin the older binary OR start fresh — there is no in-place migrator until v7.

---

## What changes when the engine is on

(In v6.1+, the engine is on by default. The right-hand column describes every bare invocation; the left-hand column describes the v5.x shape that you opt back into via `--no-engine` / `CLAUDE_AUTOPILOT_ENGINE=off` / `engine.enabled: false`. Both forms are deprecated and removed in v7.)

| Surface | v5.x shape (engine off, deprecated) | v6.1+ default (engine on) |
|---|---|---|
| Run identity | None | One ULID per run, e.g. `01HZK7P3D8Q9V…` |
| State on disk | Cost log only (`.guardrail-cache/costs.jsonl`) | Per-run dir at `.guardrail-cache/runs/<ulid>/` with `state.json`, `events.ndjson`, per-phase snapshots, copied artifacts |
| Resume after crash | Re-run from the top | `claude-autopilot run resume <ulid>` (lookup-only in v6.0; live execution lands in v6.1+) |
| Budget | Per-phase advisory (`cost.maxPerRun`) on the review surface only | Two-layer enforcement: advisory `estimateCost.high` preflight + mandatory runtime guard (`actualSoFar + conservativePhaseReserveUSD <= perRunUSD`) |
| Events for CI | Free-form text on stderr | Typed NDJSON events on stderr — `run.start`, `phase.start`, `phase.cost`, `phase.success`, `budget.check`, `phase.externalRef`, `run.complete`, … (`schema_version: 1`) |
| `--json` mode | Mixed; some commands respected it | Strict channel discipline — exactly one JSON envelope on stdout, NDJSON-only on stderr, ANSI stripped, `exit: 78` for `needs-human` in non-interactive mode |
| Idempotent replay | Each run starts fresh | Side-effect phases consult persisted `externalRefs` + provider read-back before retrying. PR comments dedup by id. Migrations consult `migration_state` before re-applying. |

## What does not change

These are **identical** in v5.x and v6:

- All review verbs (`scan`, `run`, `ci`, `fix`, `baseline`, `triage`, `explain`, `report`, `costs`)
- All deploy verbs (`deploy`, `deploy rollback`, `deploy status`)
- `migrate` / `migrate-doctor` skill contracts
- Council adapter contracts (`run`, `synthesize`)
- Bugbot triage flow
- Every env var (`ANTHROPIC_API_KEY`, `VERCEL_TOKEN`, `FLY_API_TOKEN`, `RENDER_API_KEY`, `GITHUB_TOKEN`, …)
- `guardrail.config.yaml` schema for `reviewEngine`, `staticRules`, `policy`, `cost`, `chunking`, `protectedPaths`, `ignore`, `brand`
- Exit codes for existing verbs (review surfaces still use `0` / `1` / `2`)
- The `guardrail` CLI alias

If you don't opt into the engine, your v5.x workflow runs unchanged on v6. No migration step required.

## How to opt in (or out)

As of **v6.1+**, the engine is **on by default** — bare `claude-autopilot <verb>` invocations create a run dir, emit events, and apply budget gates without any config. The four precedence layers (highest wins) still resolve as documented; users who need the engine-off shape opt out via one of the layers below (deprecated; removed in v7).

1. **CLI flag** — `--engine` / `--no-engine` per invocation. Honored by every wrapped pipeline verb (`scan`, `costs`, `fix`, `brainstorm`, `spec`, `plan`, `review`, `validate`, `implement`, `migrate`, `pr`). `--no-engine` emits a deprecation warning and is removed in v7.
2. **Env var** — `CLAUDE_AUTOPILOT_ENGINE=on|off|true|false|1|0|yes|no` (case-insensitive). Same surface coverage as the CLI flag. The `off` / `false` / `0` / `no` forms are deprecated and removed in v7.
3. **Config** — `engine.enabled: true|false` under `guardrail.config.yaml`. The `false` form is deprecated as of v6.1 and removed in v7; the `true` form is redundant on v6.1+ since it matches the default, and stays the no-op recommended form for explicit clarity.
4. **Built-in default** — **v6.1+: on** (flipped from v6.0's `off`). See [`docs/specs/v6.1-default-flip.md`](../specs/v6.1-default-flip.md).

> **What works today (v6.1 — ALL 10 PHASES WRAPPED + default flipped on):** the four knobs above resolve via the documented precedence (CLI > env > config > default) for **every** pipeline verb: `scan` (v6.0.1), `costs` and `fix` (v6.0.2), `brainstorm` and `spec` (v6.0.3), `plan` and `review` (v6.0.4), `validate` (v6.0.5), `implement` (v6.0.7), `migrate` (v6.0.8 — first side-effecting wrap, emits `migration-version` externalRefs scoped `<env>:<name>`), and `pr` (v6.0.9 — second side-effecting wrap, records a `github-pr` externalRef). The engine modules ship and are exercised by `runs list / show / gc / delete / doctor / watch` and `run resume <id>` (lookup). The `--json` channel discipline is live across every CLI verb. Budget enforcement is live for any phase that runs through `runPhase` with a `BudgetConfig`. v6.1 flipped the built-in default from off → on and added a deprecation warning when users opt out explicitly via `--no-engine` / `CLAUDE_AUTOPILOT_ENGINE=off` / `engine.enabled: false` — that escape hatch is removed in v7.
>
> **v6.0.x is feature-complete with v6.0.9.** No further wraps in v6.0.x. v6.1 flipped the default; subsequent v6.x lifts (multi-phase orchestrator, full Phase 6 readback wiring on resume, autopilot-skill inlining of implement) build on the current foundation.
>
> The reconciliation column in `docs/specs/v6-run-state-engine.md` tracks what landed when.

### Precedence matrix

```
CLI flag  →  env var  →  config  →  built-in default
--engine     CLAUDE_AUTOPILOT_     engine.enabled    v6.1+: on
--no-engine  ENGINE=on|off          true|false        (was off in v6.0)
(deprecated; removed in v7)
```

The right-most layer is the only one a user has to think about on v6.1+ — the engine is on. The three left layers remain available for opt-out (`--no-engine` / `CLAUDE_AUTOPILOT_ENGINE=off` / `engine.enabled: false`), each prints a deprecation warning, and all three are removed in v7.

Same precedence applies to the related flags:
- `--json` / `CLAUDE_AUTOPILOT_JSON=on|off` / (no config) / off
- `--non-interactive` / `CI=true` (auto-detected) / (no config) / off in TTY, on otherwise

## The `--no-engine` escape hatch

`--no-engine` (or `CLAUDE_AUTOPILOT_ENGINE=off` or `engine.enabled: false`) restores v5.x behavior — no run dir, no events, no state.json, no budget gate. **Supported for one minor version only — v6.1.** Each invocation that triggers the engine-off path now prints:

```
[deprecation] --no-engine / engine.enabled: false will be removed in v7. Migrate to engine-on (default).
```

v7 removes it; if you've held off on adopting the engine through v6.x you'll have to migrate then.

## New CLI verbs

```bash
# Inspect runs (read-only)
claude-autopilot runs list                          # newest 20
claude-autopilot runs list --status=paused          # filter
claude-autopilot runs list --status=failed --json   # CI-friendly envelope
claude-autopilot runs show <ulid>                   # state.json snapshot
claude-autopilot runs show <ulid> --events          # tail events.ndjson
claude-autopilot runs show <ulid> --events --events-tail 100

# Resume — LOOKUP ONLY in v6.0
claude-autopilot run resume <ulid>                  # answers "what would happen"
claude-autopilot run resume <ulid> --from-phase plan
# Phase 6+ wires actual execution; today this is a planning aid that
# matches what runPhase will do under live conditions.

# Garbage collection
claude-autopilot runs gc                            # 30-day cutoff (default)
claude-autopilot runs gc --older-than-days 7
claude-autopilot runs gc --dry-run                  # preview deletions
claude-autopilot runs gc --yes                      # skip confirmation (CI)

# Single-run delete
claude-autopilot runs delete <ulid>                 # terminal-status only
claude-autopilot runs delete <ulid> --force         # override the guard

# Integrity check
claude-autopilot runs doctor                        # replay events vs state.json across all runs
claude-autopilot runs doctor <ulid>                 # one run only
claude-autopilot runs doctor --fix                  # rewrite state.json from events.ndjson where drift is found
```

Every verb accepts `--json` and emits a v1 envelope (`{ schema_version: 1, command, status, exit, ... }`) on stdout when set. Channel discipline is strict — see [strict --json mode](#strict-json-mode) below.

## Live cost meter — `runs watch`

**v6.1+.** Tail a run's events.ndjson with a pretty-rendered live cost/budget meter — the "watch your $25 budget tick down while autopilot ships a PR" moment. Drop `runs watch` into a second terminal while the run is executing in the first; exits cleanly when the run terminates or on Ctrl-C.

```bash
claude-autopilot runs watch <ulid>                  # live tail, exits on run.complete
claude-autopilot runs watch <ulid> --since 42       # replay forward from seq 42
claude-autopilot runs watch <ulid> --no-follow      # snapshot once and exit (CI / scripting)
claude-autopilot runs watch <ulid> --json           # raw NDJSON to stdout (one event per line, ANSI off)
claude-autopilot runs watch <ulid> --no-color       # force ANSI off on a TTY
```

Example output (ANSI-stripped):

```
* run 01HZK7P3D8Q9V00000000000AB
  phases: spec -> plan -> implement -> pr
  budget: $0.00 / $25.00 (0%)
[12:00:01] phase.start         spec
[12:00:42] phase.cost          spec           +$0.07  (in: 1.2k, out: 3.4k)  total: $0.07
[12:00:45] phase.success       spec           OK 44.2s
[12:08:33] phase.externalRef   pr             -> github-pr#123
[12:08:34] run.complete        status=success  totalCostUSD=$4.20  duration=8m32s

done  run 01HZK7P3D8Q9V00000000000AB
  status=success  totalCostUSD=$4.20  duration=8m33s
```

**Color thresholds on the budget bar:** green <50%, yellow 50-90%, red >90%. Per-event coloring scans visually so the cost line catches your eye while the rest stays calm.

**Tail strategy:** `fs.watchFile` polls every 1s. Inotify/FSEvents notifications were unreliable for tiny ndjson appends across our test matrix (sometimes never fired, sometimes fired twice per write); the 1s polling cadence is plenty for a human-facing meter. Recovers from external file truncation by re-folding from start.

**Exit codes:** `0` clean exit (run completed or Ctrl-C), `1` invalid input or stream error, `2` not_found.

**Piping to other tools:** `--json` emits one event per line in NDJSON format with ANSI suppressed. Pipe to `jq` to filter, to a dashboard, or to `tee` for archival.

## Budget config

Add a `budgets:` block to `guardrail.config.yaml`. Two-layer enforcement (advisory + mandatory) applies the moment the engine wraps a phase that has a `BudgetConfig`:

```yaml
budgets:
  perRunUSD: 25                    # hard cap; layer 2 enforces this regardless of estimateCost
  perPhaseUSD: 10                  # optional per-phase cap
  conservativePhaseReserveUSD: 5   # default reserve for phases without estimateCost (default $5)
  councilMaxRecursionDepth: 3      # bounds synthesizer self-calls; council aborts with status='partial' on exceed
  bgAutopilotMaxRoundsPerSelfEat: 5  # autopilot orchestrator self-eat cap (consumed outside runPhase)
```

**Layer 1 (advisory).** When a phase implements `estimateCost(input)`, the runner uses `estimate.high` to preflight. If `actualSoFar + estimate.high > perRunUSD`, the runner pauses and prompts (interactive) or hard-fails (`--json` / non-interactive — exit `1`, `code: 'budget_exceeded'`).

**Layer 2 (mandatory).** Runs **regardless** of whether `estimateCost` is present. Independently checks `actualSoFar + conservativePhaseReserveUSD <= perRunUSD`. Phases that forgot to implement `estimateCost` therefore still trigger budget gates — the runtime guard never fails open.

**Council bound.** `councilMaxRecursionDepth` bounds the synthesizer's self-calls. When exceeded, the council returns `status: 'partial'` with a partial result rather than continuing.

Every check emits a `budget.check` event:

```jsonl
{"ts":"2026-05-04T18:00:01.234Z","runId":"01HZK…","seq":7,"event":"budget.check","phase":"implement","phaseIdx":2,"estimatedHigh":1.5,"actualSoFar":3.2,"reserveApplied":5.0,"capRemaining":18.3,"decision":"proceed","reason":"layer2-mandatory-pass"}
```

So your CI consumer can attribute spend per phase even when `estimateCost` is absent.

## Strict `--json` mode

Under `--json`:

- **stdout** — exactly **one** JSON envelope per command invocation. Nothing else.
- **stderr** — **only** NDJSON event lines (`{"ts":"…","runId":"…","seq":N,"event":"…",…}`). No human-readable warnings, no progress bars, no color codes.
- **No interactive prompts.** Anything that would block on a human becomes `exit: 78` ("needs-human in non-interactive mode") with a `nextActions` field on the envelope carrying the resume hint.
- **All warnings, prompts, and human diagnostics route through typed events** (`run.warning`, `run.recovery`, `phase.needs-human`, `budget.check`). The text-mode logger is disabled.

A test (`tests/cli/json-channel-discipline.test.ts`) asserts these invariants on every migrated verb. Mixed-content from any caller is a regression.

Example envelope from `runs list --json`:

```json
{
  "schema_version": 1,
  "command": "runs list",
  "status": "pass",
  "exit": 0,
  "runs": [
    {
      "runId": "01HZK7P3D8Q9V…",
      "status": "success",
      "startedAt": "2026-05-04T18:00:00.000Z",
      "endedAt":   "2026-05-04T18:30:42.500Z",
      "totalCostUSD": 4.20,
      "lastPhase": "review",
      "recovered": false
    }
  ],
  "count": 1
}
```

## Idempotency + replay rules

When the engine wraps a side-effect phase (`pr`, `migrate`, `deploy`, `bugbot`, `implement`'s git-push step), the phase's `externalRefs` are persisted into `state.json` and emitted as `phase.externalRef` events. On resume, the engine consults the persisted refs **plus a live provider read-back** — it never makes the decision from heuristics:

| Phase | Idempotent? | Side effects? | externalRef kinds | Default replay |
|---|---|---|---|---|
| `brainstorm` | no | no | `spec-file` | retry on failure |
| `plan` | no | no | `plan-file` | retry on failure |
| `implement` | partial | yes | `git-remote-push` | retry if no push, else `needs-human` |
| `migrate` | no | yes | `migration-version` (per env) | `needs-human`; on resume, read-back `migration_state` to determine actual applied state |
| `validate` | yes (read-only) | no | `sarif-artifact` | retry freely |
| `pr` | no | yes | `github-pr` | retry if no PR ref; if ref present, `gh pr view <id>` and update existing |
| `review` | yes | no | `review-comments` | retry freely; comment-by-id dedup |
| `bugbot` | partial | yes | `github-comment` (per reply), `git-remote-push` (per fix) | `needs-human`; per-comment-id replay safe |
| `deploy` | no | yes | `deploy` (provider deploy id), optional `rollback-target` | `needs-human` always; provider read-back on resume |

`needs-human` raises an interactive prompt or hard-fails (`--json` / `--non-interactive`) before resume continues. A `--force-replay` override emits an explicit `replay.override` event with the user's reason.

The pluggable provider read-back layer (`src/core/run-state/provider-readback.ts`) ships built-in adapters for `github` (via `gh`), `vercel` / `fly` / `render` (via the deploy adapters), and `supabase` (via the `migration_state` table). All read-backs **fail closed** — a parse failure, network throw, or unrecognized state collapses to `existsOnPlatform: false, currentState: 'unknown'` so the matrix routes to `needs-human` instead of a silent skip.

## Troubleshooting

### "lock_held: run X is owned by writer pid=123 host=…"

A second invocation against the same run id ran into the per-run advisory lock. Causes:
- A genuinely concurrent process (intentional or stale).
- A previous process died without releasing the lock (rare with `proper-lockfile`'s mtime watchdog).

If you're sure no other writer is alive: `claude-autopilot runs show <id>` will tell you the lock owner. Pass `--force-takeover` on the next invocation to claim ownership; the engine writes a `lock.takeover` event before proceeding so the audit trail is preserved.

> **Note (v6.0):** `--force-takeover` is implemented at the persistence layer (`src/core/run-state/lock.ts#forceTakeover`) but not yet exposed as a CLI flag on `runs delete` / `run resume`. Use `runs delete <id> --force` if you want to discard the run; otherwise wait for the follow-up CLI wiring.

### "corrupted_state: state.json failed to parse"

The snapshot file is corrupt — possibly from a SIGKILL mid-write (the rename protocol prevents this in normal operation; usually it means a power-loss or filesystem issue).

```bash
claude-autopilot runs doctor <id>          # report drift
claude-autopilot runs doctor <id> --fix    # rewrite state.json from events.ndjson
```

`events.ndjson` is the source of truth. Replay rebuilds `state.json` exactly. If `events.ndjson` is also unparseable (`events-corrupt`), the run is unrecoverable — `runs delete <id> --force` is the only path forward.

### "partial_write: tail of events.ndjson did not end with newline"

A crash between `write()` and `fsync()` left a partial event line. The engine handles this on next open: the corrupt tail is truncated, a `run.recovery(reason: 'recovered-from-partial-write')` event is written, then normal operation resumes. You should see this transition in `runs show <id> --events`. No action required unless `runs doctor` reports drift afterward.

### "budget_exceeded: layer2-mandatory-fail"

Your run hit the `perRunUSD` cap before a phase could spawn. The `budget.check` event in `events.ndjson` carries the full decision rationale (`actualSoFar`, `reserveApplied`, `capRemaining`, `decision`). Two responses:
- **Raise the cap.** Edit `budgets.perRunUSD` in `guardrail.config.yaml` and resume. Conservative if your previous estimate was wrong.
- **Inspect what was spent.** `claude-autopilot costs` reports per-phase totals; cross-reference against `runs show <id>` to find the phase that overran.

The runner never silently exceeds — every spawn-decision is recorded.

### `runs gc` won't delete an active run

By design. `gcRuns` filters out non-terminal status (`pending` / `running` / `paused`) so a concurrent writer can never lose its log mid-flight. If you're certain the run is dead and the lock is stale, use `runs delete <id> --force`.

## Default-flip plan

- **v6.0** — engine shipped **off** by default. Opt in via config / env / flag. `--no-engine` was a no-op (engine was already off).
- **v6.0.x** — point releases landed the missing wiring (`engine.enabled`, env var, CLI flags) and progressively wrapped the existing pipeline phases through `runPhase`. All 10 phases were wrapped by v6.0.9.
- **v6.1 (current)** — engine ships **on** by default after the stabilization criteria in [`docs/specs/v6.1-default-flip.md`](../specs/v6.1-default-flip.md) were met. `--no-engine` / `CLAUDE_AUTOPILOT_ENGINE=off` / `engine.enabled: false` keep working as a one-version escape hatch and emit a deprecation warning on every invocation.
- **v7** — `--no-engine`, `CLAUDE_AUTOPILOT_ENGINE=off`, and `engine.enabled: false` are removed. The engine is the only mode.

If your CI relies on the v5.x output shape, set `CLAUDE_AUTOPILOT_ENGINE=off` (or `--no-engine`) explicitly on every invocation through v6.x — that pins the behavior across the default flip and lets you migrate on your schedule. You'll see the deprecation warning until you remove it; v7 will silently ignore the flag.

## What v6 deliberately defers

- **Cross-machine sync of run state.** The ledger is local-only; if you run autopilot from two machines, runs don't merge. (Future work — possibly via an opt-in remote backend.)
- **Parallel phase execution** (multi-worktree implement). The engine supports it architecturally but doesn't enable it.
- **Web UI.** The events stream is the API; any UI is a downstream consumer.
- **GitHub App.** Orthogonal product.
- **Skill-version pinning.** Package.json hygiene; not part of the engine.

## Where to read further

- **5-minute quickstart:** [`docs/v6/quickstart.md`](./quickstart.md)
- **Full spec:** [`docs/specs/v6-run-state-engine.md`](../specs/v6-run-state-engine.md)
- **v6.1 default-flip spec:** [`docs/specs/v6.1-default-flip.md`](../specs/v6.1-default-flip.md)
- **Phase-by-phase changelog entries:** [CHANGELOG.md](../../CHANGELOG.md)
