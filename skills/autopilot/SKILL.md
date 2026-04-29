---
name: autopilot
description: After spec approval, automatically execute the full pipeline — plan → implement → migrate → validate → PR → Codex review. No manual intervention required.
---

# Autopilot — Spec to PR Pipeline

After the user approves a spec during brainstorming, this skill runs the full pipeline automatically.

## Prerequisites

- Approved spec file at `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Superpowers plugin installed (`writing-plans`, `using-git-worktrees`, `subagent-driven-development`)
- Scripts installed and dependencies present (run step 0 preflight to verify)

## CRITICAL: Do Not Pause

**Run the entire pipeline without stopping.** Do NOT:
- Ask "want me to continue?" between steps
- Show intermediate results or ask for confirmation
- Pause to report progress mid-pipeline
- Wait for user input between any steps

The ONLY time you stop is if a step **fails and cannot be recovered**. Otherwise, execute all steps sequentially and report ONCE at the end (Step 9).

Brief status lines like `[autopilot] Step 3: Executing plan...` are fine. Full summaries, questions, or check-ins are not.

## Pipeline

Execute these steps in order. Do NOT pause between steps unless a step fails.

### Step 0: Preflight

```bash
npx tsx scripts/preflight.ts
```

If any check **fails** (red ✗): stop and tell the user what to fix before continuing.
If checks only **warn** (yellow !): proceed — degraded steps will be noted in the final report.
If all pass: continue immediately, no user interaction needed.

### Step 1: Write Implementation Plan

```
Invoke: superpowers:writing-plans
Input: The approved spec file
Output: Plan at docs/superpowers/plans/YYYY-MM-DD-<topic>.md
```

Commit the plan. Do NOT ask the user for execution choice — always use subagent-driven development.

### Step 2: Set Up Worktree

```
Invoke: superpowers:using-git-worktrees
Branch: feature/<topic-slug>
```

After the worktree is created, symlink the local env file into it so scripts
(validate, Codex review, migrate) can read secrets:

```bash
# Detect which env file the project uses
ENV_FILE=$(ls .env.local .env.dev .env.development .env 2>/dev/null | head -1)
if [ -n "$ENV_FILE" ]; then
  ln -sf "$(pwd)/$ENV_FILE" ".claude/worktrees/<branch>/$ENV_FILE"
fi
```

If no env file is found, note it in the preflight output (step 0 will have caught this).

### Step 3: Execute Plan

```
Invoke: superpowers:subagent-driven-development
Input: The plan file
Mode: dispatch fresh subagent per task
```

For each task:
- Dispatch implementer subagent
- On completion: verify commit landed in worktree
- Skip formal spec/quality review to maintain speed (the validate step catches issues)
- If subagent fails to write to worktree: implement directly

### Step 4: Migrate

After implementation creates schema changes, the autopilot pipeline runs the migrate phase via the canonical dispatcher contract. The dispatcher:

1. Reads `.autopilot/stack.md` → looks up `migrate.skill` (default: `migrate@1`)
2. Resolves the skill via the alias map (path-escape protected)
3. Performs version handshake (skill manifest must declare a runtime range that includes the current `claude-autopilot` version, and an API version major matching the envelope contract)
4. Builds an invocation envelope (`{ contractVersion, invocationId, nonce, env, repoRoot, changedFiles, gitBase, gitHead, ci, ... }`) passed to the skill via env vars + stdin
5. Enforces policy (4-flag CI prod gate + clean-git + manual-approval + dry-run-first)
6. Executes the configured command via `spawn(shell:false)` — structured argv only, no shell injection
7. Parses the result artifact (file-first, nonce-bound stdout fallback only if skill manifest opts in)
8. Writes a hash-chained audit log entry to `.autopilot/audit.log`
9. Branches on `nextActions[]` from the result (e.g. `regenerate-types` triggers `npm run typecheck`)

For the autopilot pipeline, this is invoked once per migration affected by the implementation changes.

#### CI prod safety floor

Running `--env prod` from CI requires **all four** of these (skills cannot relax):
1. `--yes` flag explicit
2. `AUTOPILOT_CI_POLICY=allow-prod` env var
3. `AUTOPILOT_TARGET_ENV=prod` env var (must match `--env`)
4. `migrate.policy.allow_prod_in_ci: true` in stack.md

Plus a recognized CI provider env (GitHub Actions / GitLab CI / CircleCI / Buildkite / Jenkins) — or an explicit `AUTOPILOT_CI_PROVIDER=<name>` override for self-hosted CI.

#### Configuration source of truth

All migrate behavior is configured in `.autopilot/stack.md`. The autopilot skill never invokes a specific runner directly; it always dispatches through `claude-autopilot dispatch`. See:
- `docs/superpowers/specs/2026-04-29-migrate-skill-generalization-design.md` — full spec
- `docs/skills/rich-migrate-contract.md` — envelope + result artifact contract for skill authors
- `docs/skills/version-compatibility.md` — runtime/skill version compatibility matrix
- `presets/schemas/migrate.schema.json` — JSON Schema for the stack.md migrate block

### Step 5: Validate

```bash
npx tsx scripts/validate.ts --commit-autofix --allow-dirty
```

If FAIL:
- Read the validation report at `.claude/validation-report.json`
- Fix the blocking issues
- Re-run validate
- Max 3 retry iterations

If PASS: proceed to PR.

### Step 6: Push + Create PR

```bash
git push -u origin <branch>
gh pr create --title "<concise title>" --body "<generated PR body with spec link, test plan>"
```

### Step 7: Codex PR Review

```bash
npx tsx scripts/codex-pr-review.ts <pr-number>
```

Posts Codex review as a GitHub PR comment. If critical findings:
- Fix them on the branch
- Push
- Re-run Codex review
- Max 2 iterations

### Step 8: Bugbot Triage + Fix

Wait 60 seconds for Cursor bugbot to post comments, then:

```bash
npx tsx scripts/bugbot.ts --pr <pr-number>
```

Triages each finding (real bug vs false positive), auto-fixes real bugs, dismisses false positives with GitHub replies. If fixes applied:
- Push
- Wait for new bugbot comments (30s)
- Re-run /bugbot
- Max 3 rounds

### Step 9: Report

Tell the user:
- PR URL
- Test count
- Validation verdict
- Codex review summary
- Bugbot triage summary (fixed / dismissed / needs-human)
- Any human-required items that couldn't be auto-fixed

## Error Recovery

- **Subagent failure:** Re-dispatch with more context or implement directly
- **Migration failure:** Fix the migration source (per the configured `migrate.skill` in stack.md), re-dispatch via `claude-autopilot dispatch migrate`
- **Validate failure:** Fix issues, re-run (max 3 retries)
- **Codex critical findings:** Fix, push, re-review (max 2 retries)
- **Bugbot findings:** /bugbot handles triage + fix automatically (max 3 rounds)
- **Unrecoverable error:** Stop, report what was completed, show remaining work

## When NOT to Use

- During brainstorming (this runs AFTER spec approval)
- For hotfixes (too heavy — just commit and push)
- When the user wants manual control over each step
