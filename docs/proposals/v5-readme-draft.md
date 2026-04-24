# v5 README draft — pipeline-first positioning

**Status:** proposal. Replaces the top ~230 lines of `README.md`. Everything after `## Configuration` can keep its current structure.

**What changes in framing:** today's README sells one verb (`guardrail run`). The real product is the end-to-end pipeline. This draft leads with the pipeline, shows a 30-second demo, benchmarks against the *actual* competitive set (Devin / Copilot Workspace / Factory / OpenHands — not CodeRabbit / BugBot), and only then introduces the individual commands.

---

# @delegance/claude-autopilot

**Autonomous development pipeline for Claude Code. Brainstorm → spec → plan → implement → migrate → validate → PR → review → merge — all from your terminal, on your codebase, with your test suite.**

```bash
claude-autopilot brainstorm "add SSO with SAML for enterprise tenants"
# → writes spec (reviewed by Codex) → writes plan (reviewed by Codex) →
# → creates branch → implements with subagents → runs migrations →
# → runs full test + lint + type + security gate → opens PR →
# → dispatches multi-model review → auto-fixes bugbot findings →
# → ready to merge
```

*No hosted agent. No per-seat subscription. Runs locally on your machine, against your real repo, using your API keys. Every phase is a Claude Code skill you can intervene in, rewire, or run by itself.*

---

## Why this vs the alternatives

AI coding tools fall into three buckets. Here's where claude-autopilot sits.

| Tool | Shape | Hosted? | Model lock-in | Pipeline structure | You can intervene mid-flow? |
|---|---|---|---|---|---|
| **Devin** (Cognition) | Autonomous agent | Yes (SaaS, $500/mo) | Cognition's stack | Opaque | No — watch a dashboard |
| **GitHub Copilot Workspace** | Spec → plan → PR | Yes | Copilot only | Fixed, non-extensible | Edit the plan, that's it |
| **Factory Droids** | Multi-agent workflow | Yes (per-seat) | Factory's stack | Fixed | Limited |
| **Cursor BugBot / Copilot Review / CodeRabbit** | Async PR reviewer | Yes | Vendor's model | Single phase (review only) | N/A — post-hoc only |
| **Aider / Cline / Cursor agent mode** | Interactive pair programming | Local | User's choice | None — single-shot prompts | Continuous |
| **OpenHands / SWE-agent** | Open-ended agent framework | Local | User's choice | None — agent decides | Rare, research-grade |
| **claude-autopilot** | **Opinionated local pipeline** | **Local** | **Any LLM (Claude / GPT / Gemini / Groq / Ollama)** | **Fixed but rewireable, skill-per-phase** | **Every phase. All state on disk.** |

The architectural differences that matter most in practice:

1. **Multi-model by design.** Claude writes code, Codex reviews the plan, bugbot triages PR findings. Different model for each role, swap any of them. The pipeline's phases are explicit contracts, not one opaque API call.
2. **Your stack, not a sandbox.** It runs your `npm test`, your `prisma migrate`, your `gh pr create`, your `ruff check`. If it works in your terminal, it works in the pipeline.
3. **Phase artifacts on disk, editable.** Every phase writes to a file you can open — `docs/specs/*.md`, `docs/plans/*.md`, a branch, a PR. Stop, edit by hand, resume, or re-run any phase in isolation.
4. **Test-gated auto-revert as a first-class command.** `claude-autopilot review fix --verify` patches a file, runs your full test suite, and reverts on failure. Built into the CLI, not a wrapper you write yourself.

## 30-second quickstart

```bash
# Install
npm install -g @delegance/claude-autopilot

# One-shot setup — detects stack, writes config, installs skills, sets hooks
npx claude-autopilot init

# Ship a feature end-to-end
claude-autopilot brainstorm "add rate limiting to the public API"
# Answer ~5 questions. Spec written. Codex reviews it. You approve.
# Claude walks the plan → implementation → migration → tests → PR → review.
# ~15-40 min for a typical feature.

# Or run just the review layer on an existing PR
claude-autopilot review --pr 123
```

## The pipeline, phase by phase

Each phase is a Claude Code skill (`.claude/skills/<name>/SKILL.md`). You can invoke any phase directly (`/brainstorm`, `/plan`, `/migrate`, `/validate`) without running the full pipeline. You can also rewire the pipeline by editing the `autopilot` skill.

| Phase | Skill | What it does | Model role |
|---|---|---|---|
| **Brainstorm** | `brainstorming` | Turns a rough idea into an approved spec through guided questions | Claude (implementation model) |
| **Spec review** | `codex-review` | Second model critiques the spec before you commit to it | Codex / GPT-5 |
| **Plan** | `writing-plans` | Breaks spec into phased, checklist-shaped implementation plan | Claude |
| **Plan review** | `codex-review` | Second model critiques the plan before you execute it | Codex / GPT-5 |
| **Implement** | `subagent-driven-development` | Executes plan in a git worktree, one phase at a time, with per-phase tests | Claude |
| **Migrate** | `migrate` | Runs database migrations dev → QA → prod with per-env validation | Deterministic |
| **Validate** | `validate` | Static rules + tests + type check + security scan + LLM review | Any |
| **PR** | `commit-push-pr` | Opens the PR with auto-generated title, summary, and test plan | Claude |
| **Review** | `review-2pass` / `council` | Multi-model review of the diff (critical pass + informational pass) | Multiple |
| **Triage** | `bugbot` | Fetches automated reviewer findings, auto-fixes real bugs, dismisses false positives | Claude |

## What's distinctive

Features that are hard or impossible to find in the competitive set:

- **Multi-model council review** — dispatch the same diff to 3+ models in parallel, synthesize agreement. Catches blind spots no single model sees.
- **Fix with test verification** — `claude-autopilot fix` runs your full test suite after every patch and reverts on failure. Safer than any tool that proposes fixes without running your tests.
- **Bug-bot auto-triage** — watches Cursor BugBot / Copilot comments on your PR, triages each (real bug vs false positive), auto-fixes confirmed bugs, dismisses noise with explanations.
- **Schema alignment rule** — ensures DB migrations, backend types, and frontend types stay in sync. Custom static rule, not something any competitor ships.
- **SARIF output + GitHub Code Scanning integration** — findings appear as annotations in the PR and in the Security tab.

## Just the review layer

If you don't want the full pipeline, `claude-autopilot review` is a strict superset of what `guardrail run` used to do: LLM code review over git-changed files, SARIF output, inline PR comments, auto-fix, baselines, per-finding triage, cost budgets. The legacy `guardrail` CLI is aliased to `claude-autopilot review` for backward compat through v5.x.

```bash
claude-autopilot review                          # review changes since main
claude-autopilot review --inline-comments        # post per-line PR annotations
claude-autopilot review --format sarif --output out.sarif
claude-autopilot review --fix --verify           # LLM patch + test gate + revert on fail
```

## Install & requirements

```bash
npm install -g @delegance/claude-autopilot
```

- Node 22+
- `gh` CLI (for PR phases)
- One of: `ANTHROPIC_API_KEY` (recommended), `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `GROQ_API_KEY`
- Claude Code CLI (for skill-based phases — pipeline falls back to direct CLI invocations without it, but loses interactive checkpoints)

---

*The rest of this file (command reference, configuration, presets, CI integration, SARIF details, cost tuning) keeps its current structure unchanged — it's a solid reference, just not a landing page.*
