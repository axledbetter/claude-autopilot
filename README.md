# claude-autopilot

End-to-end Claude Code pipeline: approved spec → implementation plan → git worktree → subagent-driven implementation → migrations → validation → PR → Codex review → bugbot triage. Runs without pausing between steps.

Status: **v0.1 — extracted from a working internal deployment. Delegance-specific rules remain in the validate phase files. Config surface is minimal (stack description only). See _customize_ below.**

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
# From your repo root:
cp -R /path/to/claude-autopilot/.claude/skills/autopilot ./.claude/skills/
cp -R /path/to/claude-autopilot/scripts/* ./scripts/

# Install tsx runtime and OpenAI SDK if you don't have them
npm install --save-dev tsx openai dotenv

# Create a .autopilot dir and describe your stack for Codex reviews
mkdir -p .autopilot
cat > .autopilot/stack.md <<'EOF'
A Next.js 15 App Router app with:
- TypeScript, React 19
- Postgres via Prisma
- Vitest for tests
- Vercel deployment
EOF
```

## Usage

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

### `scripts/validate/phase5-codex.ts`
Calls Codex 5.3 to review the diff. Uses `.autopilot/stack.md` if present (see install above).

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
  codex-review.ts                        # standalone spec/plan review
  codex-pr-review.ts                     # PR diff review + GitHub comment
  bugbot.ts                              # Cursor bugbot triage + auto-fix
  validate.ts                            # pre-PR validation pipeline entry
  validate/
    phase1-static.ts                     # static checks (Delegance rules; customize)
    phase2-autofix.ts                    # ESLint --fix, prettier
    phase4-tests.ts                      # affected-tests runner
    phase5-codex.ts                      # Codex diff review + auto-fix
    phase6-gate.ts                       # merge gate (bugbot HIGH count)
    exec-utils.ts                        # shell exec helpers
    git-utils.ts                         # merge base, touched files
    reporter.ts                          # console + JSON report output
    protected-paths.ts                   # paths where auto-fix is blocked
    types.ts                             # Finding, ValidationReport, etc.
.autopilot/
  stack.md.example                       # example stack description for Codex reviews
```

## What's NOT included

- `scripts/supabase/migrate.ts` (the script the migrate skill calls — Delegance-specific Supabase Management API wrapper)
- The `check-*.ts` phase 1 detail files (Delegance email/sender checks)
- The **superpowers** plugin itself — install separately via the Claude Code plugin marketplace (see prerequisites)
- A test harness for the scripts themselves (you'll want to add one)

## License

MIT. Use it however helps.

## Known limitations

- v0.1 is a starter kit, not a polished plugin. Expect to rewrite `phase1-static.ts` and `bugbot.ts` for your codebase.
- Assumes GitHub for PRs (`gh` CLI). GitLab / Bitbucket would require replacing those calls.
- Assumes Cursor bugbot for review comments. Other review bots (CodeRabbit, Greptile) would need a different parser.
- `codex-review.ts` + `codex-pr-review.ts` assume OpenAI's GPT-5.3 Codex. Swap models via `CODEX_MODEL` env var.

## Contributing

This is a fork-and-adapt starter. Keep the shape (skill → scripts → phases), swap the rules. PRs welcome if you want to generalize a check into a config-driven pattern.
