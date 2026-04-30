# claude-autopilot end-to-end demo

## What you're seeing

One real autonomous run on a real codebase. No edits by hand. The transcript below is the actual sequence; timestamps are wall clock; costs are exact. The PR is live: <https://github.com/axledbetter/randai-johnson/pull/9>.

## The repo

[`axledbetter/randai-johnson`](https://github.com/axledbetter/randai-johnson) — a Python 3.11 Slack bot that posts real-time Mariners game commentary. ~10k lines of source, 631 pytest tests, hobby project (not production-critical). Picked because it's a real codebase the operator did not write today, with a non-trivial prediction engine (`PredictionStack` — 700 lines, 5 evaluation layers).

## The ask

> Wire up the stubbed `_get_matchup(batter_name)` method in `src/tools/tool_executor.py` so it returns real batter-vs-pitcher matchup data using the existing prediction stack in the codebase. Add tests that cover (a) successful matchup with mock prediction stack data, (b) graceful handling when the prediction stack returns empty/None, and (c) the existing 'No batter name' error path.

Single-source-file change, but requires reading three other modules to understand the prediction stack interface (`src/engine/prediction_stack.py`, `src/data/contract_packager.py`, `src/processors/pregame.py`).

## The run

| Phase | Started | Duration | Cost | Output |
|---|---|---|---|---|
| brainstorm | 00:15:56 | 2m | ~$0.40 (Anthropic) | Spec at `docs/superpowers/specs/2026-04-30-get-matchup-prediction-stack-design.md` |
| plan | 00:17:56 | 2m | ~$0.50 (Anthropic) | Plan at `docs/superpowers/plans/2026-04-30-get-matchup-prediction-stack.md` (6 TDD tasks) |
| implement | 00:19:57 | 4m | ~$1.20 (Anthropic) | 6 commits, 31/31 tool_executor tests green, 631/631 full suite green |
| validate | 00:24:16 | 1m | $0.054 (CLI) | Static + LLM review, 0 critical / 30 warnings (style) |
| push + PR | 00:25:13 | 1m | — | PR #9 opened |
| codex/PR review | 00:26:13 | 1m | $0.054 (CLI) | Posted review comment to PR #9, 0 critical / 30 warnings |

**Total wall clock: ~12 minutes. CLI spend: $0.11. Anthropic session spend (estimate): ~$2.10. Combined ~$2.20.**

## What it produced

- **PR:** <https://github.com/axledbetter/randai-johnson/pull/9>
- **Commits on branch:** 8 (spec, plan, 6 implementation commits — one per plan task with TDD red/green discipline)
- **Files changed:** `src/tools/tool_executor.py` (+95/-2), `tests/test_tool_executor.py` (+97/-7), spec, plan
- **Tests:** 5 new + modified matchup tests (all green); 631 total in suite (no regressions)
- **mypy --strict:** 8 errors, identical to `main` baseline (no regression)
- **Manual nudges:** zero. The pipeline ran end-to-end without a check-in. The operator answered no clarifying questions.

## Where it shines

- **TDD discipline by default.** The plan emitted `test red → impl → test green → commit` for every task. This isn't prompt-decoration — the agent caught its own type regression (mypy went 8 → 10 errors after wiring) and fixed it without being told.
- **Reads the codebase before proposing.** It found the existing `PredictionStack`, identified that `pregame.py` already runs the same packager+evaluate chain, and copied that pattern instead of inventing a new abstraction.
- **Honest baseline tracking.** It diffed mypy against `main` to verify no new errors, rather than reporting "clean" because it ignored pre-existing failures.
- **Bounded scope.** YAGNI'd live Statcast pulls, micro-signals, recent-form — produced a small PR that does exactly what was asked.

## Where it doesn't

- **The "subagent dispatch" pattern in `subagent-driven-development` skill is built for the interactive Claude Code main thread, not for nested agent threads.** The autopilot skill currently degrades to "implement directly" when run from inside an agent — fine for solo runs from the operator's terminal, surprising if you'd assumed parallel subagents.
- **CLI cost telemetry is stale.** `claude-autopilot costs` showed `$0.0177` from a run yesterday after two new $0.054 runs — the totals didn't aggregate. The per-run prints were correct; the persisted summary was not.
- **`--no-interactive` setup flag missing.** First `pr` command failed with `guardrail.config.yaml not found`; running `claude-autopilot run` once auto-creates the config. Discoverable but not signposted.
- **Validate finds 30 "warnings" on every run.** Most are stylistic (Pydantic response models, dependency injection of HTTP clients, deterministic tie-breaking). Useful as a backlog signal — would be noise if treated as merge-blockers. Default policy `fail-on=critical` is correct.
- **Skill couples to delegance-app paths.** The autopilot skill referenced `npx tsx scripts/codex-pr-review.ts` (a script that doesn't exist in randai). The CLI's built-in `claude-autopilot pr <n>` covered it, but the skill text needs decoupling.

## Compared to the alternatives

This product occupies the cell **"local CLI that drives a spec→plan→PR loop using your existing Claude subscription, on a repo it didn't write."** Devin runs in a hosted cloud sandbox and bills per "ACU" — fine for greenfield experiments, expensive when you want it inside your own dev box on a private repo. Factory.ai is task-priced and cloud-hosted; the dev cycle includes a context handoff. Copilot Workspace lives inside GitHub and is still effectively roadmap-gated. Cursor + manual prompting matches autopilot on quality but not on cycle time — the human is the controller.

The 12-minute wall clock for a multi-file, integration-aware Python change with pytest + mypy gates is the headline. The same task by hand for someone unfamiliar with the codebase is a 90-minute afternoon. For the operator who wrote it: ~30 minutes including code review of the result. Autopilot's value isn't replacing the senior engineer — it's collapsing the spec-to-PR loop while the engineer is doing something else.

What's bounded today: the skill ecosystem assumes Claude Code as the harness, the validate step assumes Anthropic-style review, and `subagent-driven-development` doesn't yet work nested. None of these are conceptual problems — they're plumbing.

## Reproduce

```bash
npm install -g @delegance/claude-autopilot@5.2.1
cd <your-repo>
claude-autopilot run --base main   # one-time: creates guardrail.config.yaml

# Then in Claude Code:
/brainstorm "<your task>"
# (approve the spec when it asks)
/autopilot
```

The pipeline runs spec → plan → implement → validate → push → PR → automated review. Stop conditions: failure that can't be auto-recovered, or 90-minute / $30 cap.

---
Generated 2026-04-30 against `@delegance/claude-autopilot@5.2.1` on `axledbetter/randai-johnson`. PR: <https://github.com/axledbetter/randai-johnson/pull/9>.
