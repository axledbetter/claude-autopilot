# claude-autopilot

End-to-end Claude Code pipeline: approved spec → implementation plan → git worktree → subagent-driven implementation → migrations → validation → PR → Codex review → bugbot triage. Runs without pausing between steps.

Status: **v0.1 — extracted from a working internal deployment and cleaned up for general use. Stack-specific rules have been stubbed or disabled. See _customize_ below.**

## What it is

A Claude Code skill (`.claude/skills/autopilot/SKILL.md`) plus the supporting TypeScript scripts it calls. The skill tells Claude _what_ to do; the scripts are _how_ each step runs.

```
brainstorming (you) → approved spec
       ↓
   /autopilot
       ↓
plan → worktree → implement → migrate → validate → PR → Codex review → bugbot
       ↓
     open PR
```

## Prerequisites

- [Claude Code](https://claude.com/claude-code) CLI
- Node.js 22+ and npm
- `gh` CLI authenticated (`gh auth login`)
- Git worktree-friendly repo
- **Superpowers plugin** — autopilot depends on `brainstorming`, `writing-plans`, `using-git-worktrees`, `subagent-driven-development`. Install via Claude Code:
  ```
  /plugin install superpowers@claude-plugins-official
  ```
  (or `/plugin marketplace add obra/superpowers-marketplace` first, then `/plugin install superpowers@superpowers-marketplace`). See [github.com/obra/superpowers](https://github.com/obra/superpowers) for Cursor/Codex/OpenCode install.
- Env vars:
  - `OPENAI_API_KEY` — for Codex review
  - `GITHUB_TOKEN` / `gh auth` — for PR creation and bugbot replies

## Install

```bash
# Clone the repo somewhere convenient
git clone https://github.com/axledbetter/claude-autopilot /tmp/claude-autopilot

# Copy skills and scripts into your repo root
cp -R /tmp/claude-autopilot/.claude/skills/autopilot ./.claude/skills/
cp -R /tmp/claude-autopilot/scripts/* ./scripts/

# Install runtime dependencies (tsx, openai, dotenv, minimatch)
npm install --save-dev tsx openai dotenv minimatch

# Describe your stack for Codex reviews — this is loaded as context on every review
mkdir -p .autopilot
cp /tmp/claude-autopilot/.autopilot/stack.md.example .autopilot/stack.md
# Edit .autopilot/stack.md to describe your actual stack and security rules
```

## Usage

**Brainstorming comes first.** Use `/brainstorming` (from superpowers) to turn an idea into an approved spec. Once the spec is written and committed, invoke autopilot:

```
/brainstorming   ← run this first (superpowers) — iterates to an approved spec
/autopilot       ← run this after the spec is approved
```

After you've brainstormed a spec and the user approves it (spec at `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`), invoke:

```
/autopilot
```

Claude Code will read `.claude/skills/autopilot/SKILL.md` and run the pipeline end-to-end.

Individual scripts are also callable manually:

```bash
npx tsx scripts/codex-review.ts path/to/spec.md            # review a spec
npx tsx scripts/codex-pr-review.ts 123                     # review an open PR
npx tsx scripts/validate.ts --commit-autofix --allow-dirty # validate before PR
npx tsx scripts/bugbot.ts --pr 123                         # triage bugbot comments
```

## Customize — what's Delegance-specific

The skill (`SKILL.md`) is generic. The scripts have project-specific rules you'll want to review:

### `scripts/validate/phase1-static.ts`
Static checks that may not apply to your stack:
- `check-email-sender-domains.ts` (checks Resend sender email domains — remove if you're not on Resend)
- `check-unchecked-email-sends.ts` (AST check for untyped `emailService.send()` calls)
- RLS bypass warning (Supabase-specific — checks comments on `createServiceRoleClient`)
- Migration integrity (expects `data/deltas/` — rename to your convention)

Action: delete or rewrite the checks that don't fit your stack. Keep the structure (phase runners, Finding type) and replace the rules.

### `scripts/validate/protected-paths.ts`
Glob patterns for files where auto-fix is blocked (auth, billing, migrations, middleware). Defaults to Delegance's conventions — replace with your own sensitive paths. Keep the shape (`PROTECTED_PATTERNS` array + `isProtectedPath()` export).

### `scripts/validate/phase5-codex.ts`
Calls Codex to review each changed module. Automatically loads full context: the most recent spec from `docs/superpowers/specs/`, the implementation plan from `docs/superpowers/plans/`, and `.autopilot/stack.md`. Codex sees what the feature was supposed to build, not just the code — enabling spec-vs-implementation gap detection.

### `scripts/bugbot.ts`
Triage rules hardcoded to our severity conventions. Key decision points:
- `CONFIDENCE_THRESHOLDS` — tune for your risk tolerance
- `PROTECTED_PATHS` — files/directories where auto-fix is blocked (auth, billing, migrations)
- Triage prompt assumes Cursor `bugbot` as the reviewer. If you use a different review bot, adapt the fetch logic and prompt.

### `.claude/skills/migrate/SKILL.md` — DB migration (Supabase)
Thin orchestrator for Supabase dev → QA → prod migrations. Depends on `scripts/supabase/migrate.ts` (NOT included — Delegance-specific; wraps the Supabase Management API + maintains a migration ledger).

The skill FILE is instructive and generic enough to adapt: it describes the "validate → dev → ask → QA → ask → prod" flow. If you use a different DB or migration tool (Prisma, Drizzle, Atlas, plain psql), keep the shape and replace the underlying script. If you don't have migrations in your pipeline at all, delete the skill + drop step 4 from `autopilot/SKILL.md`.

## What's included

```
.claude/skills/
  autopilot/SKILL.md                     # the orchestrator skill
  migrate/SKILL.md                       # DB migration orchestrator (Supabase-shaped; adapt)
scripts/
  preflight.ts                           # prerequisite check (Node, gh, tsx, env file, superpowers)
  load-env.ts                            # auto-detects .env.local / .env.dev / .env.development / .env
  codex-review.ts                        # standalone spec/plan/code review via Codex
  codex-pr-review.ts                     # PR diff review + GitHub comment
  bugbot.ts                              # Cursor bugbot triage + auto-fix orchestrator
  bugbot/
    types.ts                             # BugbotOptions, BugbotComment, TriageResult, etc.
    state.ts                             # persistent state (.claude/bugbot-state.json)
    fetcher.ts                           # fetch review comments from GitHub (customize bot author)
    triage.ts                            # Claude-powered triage (customize CONFIDENCE_THRESHOLDS)
    fixer.ts                             # auto-fix engine (customize PROTECTED_PATHS)
    commenter.ts                         # post triage replies to GitHub
    reporter.ts                          # console + GitHub summary comment
  validate.ts                            # pre-PR validation pipeline entry
  run-affected-tests.ts                  # test runner stub — replace with affected-tests logic
  validate/
    phase1-static.ts                     # static checks (hardcoded-secrets generic; add your own)
    phase2-autofix.ts                    # ESLint --fix, pattern scan
    phase4-tests.ts                      # affected-tests runner
    phase5-codex.ts                      # Codex review with full spec + plan + stack context
    phase6-gate.ts                       # merge gate (bugbot HIGH count)
    exec-utils.ts                        # shell exec helpers
    git-utils.ts                         # merge base, touched files
    reporter.ts                          # console + JSON report output
    protected-paths.ts                   # paths where auto-fix is blocked (customize)
    types.ts                             # Finding, ValidationReport, etc.
    check-email-sender-domains.ts        # stub — implement your sender domain checks
    check-unchecked-email-sends.ts       # stub — implement your async-send checks
.autopilot/
  stack.md.example                       # stack description template for Codex reviews
```

## What's NOT included

- `scripts/supabase/migrate.ts` (the script the migrate skill calls — Delegance-specific Supabase Management API wrapper)
- The **superpowers** plugin itself — install separately via the Claude Code plugin marketplace (see prerequisites)
- A test harness for the scripts themselves (you'll want to add one)

## Script contracts

| Script | Inputs | Key outputs | Exit code |
|--------|--------|-------------|-----------|
| `scripts/preflight.ts` | none | console report | 0 = all pass or warn only; 1 = hard failure |
| `scripts/validate.ts` | CLI flags (see `--help`) | `.claude/validation-report.json` | 0 = PASS; 1 = FAIL (blocking findings) |
| `scripts/codex-review.ts` | file path / `--text=` / stdin | review markdown on stdout | 0 always (errors logged to stderr) |
| `scripts/codex-pr-review.ts` | PR number | GitHub PR comment posted | 0 always |
| `scripts/bugbot.ts` | `--pr`, `--dry-run`, `--rescan` | `.claude/bugbot-state.json`; GitHub comments | 0 always |

## License

MIT. Use it however helps.

## Known limitations

- v0.1 is a starter kit, not a polished plugin. Expect to rewrite `phase1-static.ts` and `bugbot.ts` for your codebase.
- Assumes GitHub for PRs (`gh` CLI). GitLab / Bitbucket would require replacing those calls.
- Assumes Cursor bugbot for review comments. Other review bots (CodeRabbit, Greptile) would need a different parser.
- `codex-review.ts` + `codex-pr-review.ts` assume OpenAI's GPT-5.3 Codex. Swap models via `CODEX_MODEL` env var.

## Contributing

This is a fork-and-adapt starter. Keep the shape (skill → scripts → phases), swap the rules. PRs welcome if you want to generalize a check into a config-driven pattern.
