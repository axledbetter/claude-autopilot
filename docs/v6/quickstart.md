# v6 Quickstart — give me the engine, NOW

Five minutes from "engine off" to "engine on, queryable runs, hard budget cap." For the deeper "what changes / what doesn't / how to roll back" treatment, read [`docs/v6/migration-guide.md`](./migration-guide.md). For the architectural rationale, read [`docs/specs/v6-run-state-engine.md`](../specs/v6-run-state-engine.md).

## Prerequisites

- claude-autopilot v6.0+ installed (`npm install -g @delegance/claude-autopilot`).
- An existing `guardrail.config.yaml` in the project root. (Or run `claude-autopilot init` first.)
- Node 22+, `gh` CLI, an `ANTHROPIC_API_KEY` (or any supported LLM key).

## 1. Turn the engine on

Add an `engine` block to `guardrail.config.yaml`:

```yaml
configVersion: 1
reviewEngine: { adapter: auto }

# v6 opt-in. Default ships off in v6.0; will flip on in v6.1.
engine:
  enabled: true

# Optional but recommended — without budget caps the engine still
# tracks spend, but won't stop a runaway. With these in place, every
# spawn-decision is recorded as a budget.check event.
budgets:
  perRunUSD: 10
  perPhaseUSD: 5
  conservativePhaseReserveUSD: 2
```

> **Note (v6.0):** `engine.enabled` is the target shape — the config wiring is in flight across v6.0.x point releases. Today, the engine is exercised by:
>
> - The `runs list / show / gc / delete / doctor` and `run resume` CLI verbs (always available).
> - `--json` mode on every CLI verb (always available — strict channel discipline).
> - Any phase code that explicitly constructs a `RunPhase` and passes a `BudgetConfig` to `runPhase` (`src/core/run-state/phase-runner.ts`).
>
> Once the wiring lands, `engine.enabled: true` will automatically wrap the existing pipeline phases (brainstorm / plan / implement / migrate / validate / pr / review / bugbot / deploy) through `runPhase`. Track progress in the CHANGELOG.

## 2. Run a command — any command

```bash
claude-autopilot scan --all
```

Once the wiring lands, this creates `.guardrail-cache/runs/<ulid>/` and you'll see:

```
.guardrail-cache/
  runs/
    01HZK7P3D8Q9V…/
      state.json          # last-known-good snapshot
      events.ndjson       # append-only event log (source of truth)
      phases/
        scan.json         # per-phase snapshot
      artifacts/          # copies of inputs/outputs (never symlinks)
      .lock               # per-run advisory lock (released on exit)
      .lock-meta.json     # writer pid + host hash
    index.json            # cache; rebuildable from runs/*/events.ndjson
```

Two files are interesting:

- **`state.json`** — a JSON snapshot. Open it. Every phase you ran shows up with status, attempts, cost, externalRefs.
- **`events.ndjson`** — one JSON line per state transition. `tail -f` it during a long run; `jq` it after. The schema is versioned (`schema_version: 1`).

## 3. List your runs

```bash
claude-autopilot runs list
```

Newest first, with status / cost / last phase columns:

```
runId                        status      started                    cost      lastPhase
-----                        ------      -------                    ----      ---------
01HZK7P3D8Q9V…               success     2026-05-04T18:00:00.000Z   $0.21     scan
01HZK6F4XR5K2…               failed      2026-05-04T17:42:11.500Z   $1.45     implement
```

Filter:
```bash
claude-autopilot runs list --status=failed
claude-autopilot runs list --status=paused --json    # CI-friendly envelope
```

## 4. Inspect a single run

```bash
claude-autopilot runs show 01HZK6F4XR5K2…
```

Output is the state snapshot plus an optional event tail:

```
run 01HZK6F4XR5K2…  status=failed
  started: 2026-05-04T17:42:11.500Z
  ended:   2026-05-04T17:48:33.221Z
  cost:    $1.4502
  cwd:     /Users/me/projects/foo
phases:
  [x] brainstorm     $0.0700    120000ms attempts=1
  [x] plan           $0.1200    180000ms attempts=1
  [!] implement      $1.2602    220000ms attempts=2 <-
      error: tsc --noEmit failed: src/foo.ts(12,3): error TS2304
```

Add `--events` to tail `events.ndjson`:
```bash
claude-autopilot runs show 01HZK6F4XR5K2… --events --events-tail 50
```

## 5. Plan a resume

```bash
claude-autopilot run resume 01HZK6F4XR5K2…
```

> **Note (v6.0):** `run resume` is **lookup-only** in v6.0 Phase 3. It identifies which phase a future resume would pick up from + the engine's idempotency-table decision (retry / skip-idempotent / needs-human / already-complete) without actually executing the phase. Live execution wires in v6.1+.

```
run 01HZK6F4XR5K2…  status=failed
  currentPhase: implement
  nextPhase:    implement
  decision:     retry
  reason:       phase had no prior success; default replay rule for failed attempt is retry

NOTE: this is a lookup-only verb in v6 Phase 3.
      Actual phase execution wires in Phase 6+. Use it to confirm
      the engine would do the right thing before that lands.
```

`--json` returns a structured envelope you can pipe into CI tooling.

## 6. Garbage-collect old runs

```bash
claude-autopilot runs gc                    # default 30-day cutoff
claude-autopilot runs gc --older-than-days 7
claude-autopilot runs gc --dry-run          # preview without touching disk
claude-autopilot runs gc --yes              # skip confirmation (CI)
```

Active runs (`pending` / `running` / `paused`) are never deleted — by design. Use `runs delete <id> --force` if you really need to discard one.

## 7. Verify integrity (optional)

```bash
claude-autopilot runs doctor              # check every run
claude-autopilot runs doctor 01HZK…       # one run
claude-autopilot runs doctor --fix        # rewrite drifted state.json from events.ndjson
```

`runs doctor` replays each run's `events.ndjson` and compares the resulting state against `state.json`. Drift categories: `snapshot-vs-replay`, `snapshot-missing`, `snapshot-corrupt`, `events-corrupt`. Without `--fix`, exit code is `1` when any drift is found.

## That's it

You now have:

- Persistent run state on disk per project.
- Resumable runs (lookup today; execution in v6.1+).
- A typed JSON event stream for every CLI verb under `--json`.
- Hard budget caps for any phase that runs through the engine.

For more depth — what's pending vs shipped, the precedence matrix, idempotency rules, troubleshooting recipes — see [`docs/v6/migration-guide.md`](./migration-guide.md).
