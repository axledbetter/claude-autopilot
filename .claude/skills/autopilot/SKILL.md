---
name: autopilot
description: After spec approval, automatically execute the full pipeline — plan → implement → migrate → validate → PR → Codex review. No manual intervention required.
---

# Autopilot — Spec to PR Pipeline

After the user approves a spec during brainstorming, this skill runs the full pipeline automatically.

## Prerequisites

- Approved spec file at `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- All required skills installed: writing-plans, subagent-driven-development, validate, migrate, codex-review

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

### Step 4: Auto-Migrate

For any `.sql` files created in `data/deltas/` during implementation:

```bash
/migrate
```

Run against dev → QA → prod with auto-promote. If migration fails, fix the SQL and retry.

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

Posts Codex 5.3 review as a GitHub PR comment. If critical findings:
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
- **Migration failure:** Fix SQL, re-run /migrate
- **Validate failure:** Fix issues, re-run (max 3 retries)
- **Codex critical findings:** Fix, push, re-review (max 2 retries)
- **Bugbot findings:** /bugbot handles triage + fix automatically (max 3 rounds)
- **Unrecoverable error:** Stop, report what was completed, show remaining work

## When NOT to Use

- During brainstorming (this runs AFTER spec approval)
- For hotfixes (too heavy — just commit and push)
- When the user wants manual control over each step
