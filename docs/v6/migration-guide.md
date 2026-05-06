# v5.x → v6 Migration Guide

**Audience:** existing claude-autopilot users (v5.x) who want to start using the v6 Run State Engine on their next run.

**TL;DR.** v6 is a **superset** of v5.x. Every existing CLI verb keeps its current behavior. The Run State Engine is **opt-in** in v6.0 and ships **OFF by default**. To turn it on, add a single config line — and you get persistent run state, resumable phases, hard budget caps, and a typed JSON event stream that CI can consume.

---

## What changes when the engine is on

| Surface | v5.x (today, default) | v6 with engine on |
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

## How to opt in

Three ways, in **precedence order** (highest wins):

1. **CLI flag** — `--engine` / `--no-engine` per invocation. ✅ **Wired in v6.0.1 — currently honored by `scan`, `costs`, `fix`, `brainstorm`, `spec`.** Other phases land in subsequent v6.0.x releases per [`wrapping-pipeline-phases.md`](./wrapping-pipeline-phases.md).
2. **Env var** — `CLAUDE_AUTOPILOT_ENGINE=on|off|true|false|1|0|yes|no` (case-insensitive). ✅ **Wired in v6.0.1 — currently honored by `scan`, `costs`, `fix`, `brainstorm`, `spec`.**
3. **Config** — `engine.enabled: true` under `guardrail.config.yaml`. ✅ **Wired in v6.0.1 — currently honored by `scan`, `costs`, `fix`, `brainstorm`, `spec`.**
4. **Built-in default** — v6.0: **off**. v6.1+: **on**.

> **What works today (v6.0.5):** the three knobs above are wired and resolve via the documented precedence (CLI > env > config > default) for `scan` (v6.0.1), `costs` and `fix` (v6.0.2), `brainstorm` and `spec` (v6.0.3), `plan` and `review` (v6.0.4), plus `validate` (v6.0.5). The engine modules ship and are exercised by `runs list / show / gc / delete / doctor` and `run resume <id>` (lookup). The `--json` channel discipline is live across every CLI verb. Budget enforcement is live for any phase that runs through `runPhase` with a `BudgetConfig`.
>
> **What lands in v6.0.x point releases:** automatic wrapping of the remaining pipeline phases (`implement`, `migrate`, `pr`) through `runPhase` so the same three knobs activate the engine for those verbs too. Each release wraps one or two phases following the recipe in [`docs/v6/wrapping-pipeline-phases.md`](./wrapping-pipeline-phases.md). Until a phase is wrapped, passing `--engine` to it is a no-op (the dispatcher accepts the flag but the verb's internals don't observe it).
>
> The migration guide describes the **target shape** of v6 so you can plan against it. The reconciliation column in `docs/specs/v6-run-state-engine.md` tracks what landed when.

### Precedence matrix (target)

```
CLI flag  →  env var  →  config  →  built-in default
--engine     CLAUDE_AUTOPILOT_     engine.enabled    v6.0: off
--no-engine  ENGINE=on|off                            v6.1: on
```

Same precedence applies to the related flags:
- `--json` / `CLAUDE_AUTOPILOT_JSON=on|off` / (no config) / off
- `--non-interactive` / `CI=true` (auto-detected) / (no config) / off in TTY, on otherwise

## The `--no-engine` escape hatch

Once the engine becomes the default in v6.1, `--no-engine` (or `CLAUDE_AUTOPILOT_ENGINE=off`) restores v5.x behavior — no run dir, no events, no state.json, no budget gate. **Supported for one minor version only.** v7 removes it; if you've held off on adopting the engine through v6.x you'll have to migrate then.

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

- **v6.0** — engine ships **off** by default. Opt in via config / env / flag. `--no-engine` is a no-op (engine is already off).
- **v6.0.x** — point releases land the missing wiring (`engine.enabled`, env var, CLI flags) and progressively wrap the existing pipeline phases through `runPhase`. CHANGELOG calls out each wave.
- **v6.1** — engine ships **on** by default after a stabilization period (target: 30 days on master with no engine-related bug reports, all bugbot findings on engine code addressed). `--no-engine` becomes the explicit escape hatch and is documented.
- **v7** — `--no-engine` removed. The engine is the only mode.

If your CI relies on the v5.x output shape, set `CLAUDE_AUTOPILOT_ENGINE=off` (or `--no-engine`) explicitly on every invocation through v6.x — that pins the behavior across the default flip and lets you migrate on your schedule.

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
