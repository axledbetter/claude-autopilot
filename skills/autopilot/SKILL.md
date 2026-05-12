---
name: autopilot
description: End-to-end pipeline — brainstorm → spec → plan → implement → migrate → validate → PR → Codex review → bugbot. Risk-tiered. No manual intervention after spec approval.
---

# Autopilot — Idea to Merged PR Pipeline

Drives the full flow from raw user idea (or an existing spec) through merged PR. The ONLY pause is explicit user approval of the spec after Step 0; everything after that runs unattended unless blocked by an unrecoverable failure, missing credentials, or an unresolved CRITICAL Codex finding.

## Entry decision tree

Pick the entry point ONCE at the start:

- **Approved spec path provided** (e.g. `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`) → skip Step 0, jump to Step 1.
- **Only an idea provided** (no spec) → run Step 0 to brainstorm + spec it.
- **Neither** → ask the user once for either the spec path or the idea. This is the only allowed pre-pipeline pause.

## Prerequisites (hard-gate)

The pipeline ABORTS with a clear actionable error if any of these are missing:

- **Required skills:** `superpowers:brainstorming`, `superpowers:writing-plans`, `superpowers:subagent-driven-development`, `superpowers:using-git-worktrees` (for Step 2)
- **Required project scripts:** `scripts/codex-review.ts`, `scripts/codex-pr-review.ts`, `scripts/bugbot.ts`, `scripts/validate.ts` — OR equivalent CLI verbs from `@delegance/claude-autopilot` if running the package version
- **Required env:** `OPENAI_API_KEY` (for Codex passes), `GITHUB_TOKEN` or `gh auth status` (for PR creation), `ANTHROPIC_API_KEY` (for impl agents)

If any superpowers skill is missing, print:
```
Autopilot requires superpowers plugin. Install with: claude plugin install superpowers
```
and exit. Do NOT half-run with a missing dependency.

## Operational preflight (run before Step 0/1)

Verify before any LLM call:

1. **Working-tree state** — `git diff --quiet` AND `git diff --cached --quiet` must both succeed (no dirty tracked changes). Run `git status --porcelain` to enumerate untracked files; abort if any are present unless the user explicitly opted in via `--allow-untracked`. Additionally, current branch MUST NOT be `main`/`master` — create a dedicated worktree/branch first if it is.
2. **GitHub auth + push permission** — `gh auth status` AND `gh repo view <owner>/<repo>` succeed; if the target remote is a fork, verify push permission with a no-op `git push --dry-run origin HEAD:refs/heads/<probe-branch>` (or `gh api -X GET repos/<owner>/<repo>/collaborators/<user>/permission`). Abort if the authenticated user cannot push to the target branch.
3. **Codex CLI resolution** — Resolve the codex-review command ONCE here and cache the resolved invocation for the rest of the pipeline. Try in order: `npx tsx scripts/codex-review.ts --help` (project-local), then `npx claude-autopilot codex-review --help` (package CLI fallback). Use whichever resolves first; abort if neither does.
4. **Test runner reachable** — Detect from `package.json`: if `scripts.test` is defined, run `npm run test -- --help` (or framework-specific equivalent: `vitest --version`, `jest --help`, `playwright --version`). Do NOT assume `--dry-run` is supported. Abort only if no test script is detected AND no project validation script exists.
5. **Migration tool reachable** (if `data/deltas/` exists) — `/migrate` skill or `supabase` CLI

If any preflight check fails, abort with the specific check and remediation hint. Do NOT proceed and discover the failure mid-pipeline.

**Risk-tier confirmation is preflight, not mid-pipeline.** If the entry path is an approved spec and the spec's frontmatter is missing `risk:`, run the keyword auto-escalation rule (see below) and surface the inferred tier as a single preflight prompt BEFORE Step 1 begins. This is the same pre-pipeline pause class as "ask for the spec path"; it is not a mid-pipeline check-in.

## CRITICAL invariant — Do Not Pause (after spec approval)

There are exactly TWO allowed pre-pipeline pause classes, both occurring BEFORE Step 1:

1. **Step 0 brainstorming user input** — the user picks an approach in substep 1 and explicitly approves the final spec at the end. These are intrinsic to brainstorming, not mid-pipeline check-ins.
2. **Preflight prompts** — missing entry inputs (spec path or idea), and risk-tier confirmation when frontmatter is missing `risk:`. These resolve before Step 1 starts.

After Step 1 begins, do NOT:

- Ask "want me to continue?" between steps
- Show intermediate results or ask for confirmation
- Pause to report progress mid-pipeline
- Wait for user input between any steps

The pipeline halts ONLY for:
- Unrecoverable step failure (retries exhausted)
- Missing credentials surfaced mid-run (despite preflight)
- An **unresolved CRITICAL Codex finding** (see acceptance rules below)
- An external system hard-block (TCC permission revoked, network outage, etc.)

Brief status lines like `[autopilot] Step 3: Executing plan...` are fine. Full summaries, questions, or check-ins are not. Report ONCE at the end (Step 9).

## Codex pass policy (risk-tiered)

> Adopted from the v7.4.1 strategic review. The v8 spec pass-2
> finding 3 CRITICALs the original spec missed (sandbox / credential
> exfiltration) was concrete evidence that 1 codex pass is
> insufficient for security-sensitive architecture. But running 3
> passes on every CLI polish spec adds latency without value.

**Specs must declare risk in YAML frontmatter:**
```yaml
---
title: <spec title>
risk: low | medium | high
---
```

**Pass-count rules:**

| Spec risk | Triggers | Codex passes (idea-entry) | Codex passes (approved-spec-entry) |
|---|---|---|---|
| **Low** | CLI UX, doc-only PRs, scaffolding extensions, config polish, CI workflow tweaks | **1 pass** on the committed spec | **1 pass** on the committed spec (Step 1) |
| **Medium** | New execution modes, auth changes, billing flows, data-access patterns, new env vars, API contracts | **2 passes** (1 draft in Step 0, 1 on merged spec in Step 1) + Step 7 PR review | **2 passes** on the committed spec in Step 1 (back-to-back, with remediation between) + Step 7 PR review |
| **High** | Sandboxing, multi-tenancy, auto-merge, repo mutation, new secrets handling, RPC/SECURITY DEFINER changes | **3 passes** (1 draft, 1 post-edit in Step 1, 1 pre-impl) + Step 7 PR review | **3 passes** on the committed spec in Step 1 (each followed by remediation) + Step 7 PR review |

**Entry-path semantics:** When entering with an approved spec (no Step 0 draft pass available), run the full required pass count starting in Step 1, applying remediation and re-running until CRITICALs are clean. Optionally, the spec may declare prior Codex passes in frontmatter (`codex_passes_completed: <n>`) to credit toward the requirement.

**Backward-compatibility for missing `risk:`:**

If the spec frontmatter is missing `risk:`, default to `medium` AND emit a warning. Auto-escalate to `high` if the spec content contains any of these keyword triggers:
- `multi-tenant`, `tenancy`, `RLS`, `SECURITY DEFINER`
- `secret`, `credential`, `vault`, `token-handling`
- `auto-merge`, `automerge`, `sandbox`, `sandboxed`
- `auth`, `OAuth`, `SAML`, `SSO`
- `repo mutation`, `force-push`

The risk-tier confirmation happens during preflight (see "Risk-tier confirmation is preflight, not mid-pipeline" above), not as a separate mid-pipeline pause.

**Step 0 substep passes are ALWAYS 1 initial pass each, regardless of spec risk.** Brainstorming is draft-stage feedback, not load-bearing security review. The risk-tiered policy applies starting at Step 1 (where the spec is committed). Note that CRITICAL findings in a Step 0 substep still trigger remediation + re-pass per the acceptance rules below — "1 initial pass" means "1 pass to surface findings," not "1 pass total even with unresolved CRITICALs."

## Acceptance rules for Codex findings (CRITICAL — remediation semantics)

This is the load-bearing rule. Misreading it can ship vulnerable code.

- **CRITICAL findings: must be REMEDIATED, not just acknowledged.** Apply the fix to the spec/plan/code, then re-run the Codex pass. The pipeline MAY NOT proceed while any CRITICAL finding remains unresolved. "Auto-accept" never means "continue past."
- **WARNING findings:** remediate by default. Skip ONLY if the finding directly contradicts a locked user requirement; in that case, document the skip in the PR description with the reason.
- **NOTE findings:** discretionary. Roll into a "post-launch follow-ups" appendix if relevant; otherwise ignore.

After each Codex pass, present a single-line summary table to the user (severity + title + remediation status). Do NOT pause for "should I incorporate these?" — apply the rules above and continue.

## Tempfile naming (avoid concurrent-session collisions + secure-by-default)

Codex passes write to temporary input files. Use a per-run isolated directory with restrictive permissions, NOT a shared `/tmp` path:

```
<dir> = mkdtemp("${TMPDIR:-/tmp}/claude-autopilot-XXXXXX")   # mode 0700
<file> = $dir/codex-input-<topic-slug>-<step>.md             # mode 0600, exclusive create (O_EXCL)
```

The timestamp+pid pattern from earlier drafts is INSUFFICIENT — it is predictable, world-readable in shared `/tmp`, and vulnerable to symlink races. Always use `mkdtemp` (or platform-equivalent) to get a randomized, exclusively-created directory before writing the file.

Example resolved path: `/tmp/claude-autopilot-aB3xQ9/codex-input-v8-daemon-step-arch.md`

Rules:
- Use `mkdtemp` (Node: `fs.mkdtempSync(path.join(os.tmpdir(), 'claude-autopilot-'))`) — never a hand-built path
- Set file mode `0600` on creation; set dir mode `0700`
- Clean up the entire temp directory in a `finally` block (success OR failure)
- Specs may contain sensitive architecture details (tenant/RLS behavior, auth flows, schema names, internal endpoints). The "no secrets" rule extends to "no production-sensitive design content in tempfiles you'd be uncomfortable surfacing"; paraphrase such content before writing
- Never write secrets, API keys, or production credentials to tempfiles regardless of location

## Step 0: Brainstorming with per-step Codex validation

**Skip this step entirely if a spec already exists.** Otherwise:

Drive `superpowers:brainstorming` from the user's idea. **At each substep below, automatically run `/codex-review` and incorporate findings before moving on.** One pass per substep. Do not wait to be prompted.

Codex-validate after each of these brainstorming substeps:

1. **Approach selection** — after presenting 2–3 approaches and the user picks one, write the chosen approach + rejected alternatives to a tempfile (per pattern above) and run the resolved codex-review command (from preflight, typically `npx tsx scripts/codex-review.ts <tempfile>` for project installs, or the package CLI fallback). Apply CRITICAL findings before proceeding (remediate, then re-pass if needed).
2. **Architecture section** — after presenting the top-level architecture (boxes/arrows + key principles), Codex-validate; remediate CRITICALs.
3. **Components + data flow section** — after detailing components, schemas, and data flow, Codex-validate; remediate CRITICALs.
4. **Error handling + testing section** — after specifying failure modes and test strategy, Codex-validate; remediate CRITICALs.
5. **Prepare final spec draft** — once the spec doc is written and self-reviewed, capture WARNINGs/NOTEs into a "post-launch follow-ups" appendix. (The load-bearing final spec validation happens in Step 1, NOT here — Step 0 produces a draft ready for the risk-tiered pass.)

Each substep uses ONE initial Codex pass for fast design feedback. Additional revalidation passes are required ONLY when CRITICAL findings are remediated (per the acceptance rules above) — "one initial pass" is not a cap on re-passes after remediation.

**Exit Step 0 with:**
- Committed spec at `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Spec includes `risk: low|medium|high` in frontmatter (or accept the default-medium per the backward-compat rule)
- User has explicitly approved the spec (this is the ONLY allowed pause in the entire pipeline)

## Pipeline

Execute these steps in order. Do NOT pause between steps unless a step fails per the acceptance rules.

### Step 1: Risk-tiered final spec validation + write implementation plan

**First — risk-tiered pass on the committed spec** per the policy table above:
- Low risk: 1 pass on the spec
- Medium risk: 2 passes (this one + Step 7 codex PR review serves as pass 2)
- High risk: 3 passes (this + Step 7 + an explicit pre-implementation pass)

Remediate CRITICALs in-place on the spec before moving on.

**Then write the plan:**
```
Invoke: superpowers:writing-plans
Input: The approved + validated spec
Output: Plan at docs/superpowers/plans/YYYY-MM-DD-<topic>.md
```

After the plan is written but BEFORE committing it, run `npx tsx scripts/codex-review.ts <plan-path>`. Apply CRITICAL findings (sequencing errors, missing test coverage on a load-bearing path, schema/migration ordering bugs) to the plan inline. Then commit. Always use subagent-driven development for execution — do not ask the user.

### Step 2: Set up worktree

```
Invoke: superpowers:using-git-worktrees
Branch: feature/<topic-slug>
```

### Step 3: Execute plan

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

### Step 4: Auto-migrate

For any `.sql` files created in `data/deltas/` during implementation:

```bash
/migrate
```

Run against dev → QA → prod with auto-promote. If migration fails, fix the SQL and retry.

### Step 5: Validate

Run both checks in order:

```bash
# 1. Static rules + LLM review on changed files
npx autopilot run --base main

# 2. Full project validation (autofix, tests, codex, gate)
npx tsx scripts/validate.ts --commit-autofix --allow-dirty
```

The `validate.ts` Phase 1 includes a **tsc regression check**: it runs `npx tsc --noEmit` against both the PR and the merge-base (cached at `.claude/.tsc-baseline-cache.json`) and surfaces only files where the PR introduces *new* TypeScript errors versus the baseline. Forward-pressure check — type errors are warnings, not blockers.

If either FAIL:
- Read findings / validation report at `.claude/validation-report.json`
- Fix the blocking issues
- Re-run the failing check
- Max 3 retry iterations

If both PASS: proceed to PR.

### Step 6: Push + create PR

```bash
git push -u origin <branch>
gh pr create --title "<concise title>" --body "<generated PR body with spec link, test plan>"
```

### Step 7: Codex PR review

```bash
npx tsx scripts/codex-pr-review.ts <pr-number>
```

Posts Codex review as a GitHub PR comment. **This serves as the second risk-tiered pass for medium-risk specs and the third pass for high-risk specs.** Remediate CRITICAL findings:
- Fix on the branch
- Push
- Re-run Codex review
- Max 2 iterations

### Step 8: Bugbot triage + fix

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
- Codex review summary (passes run, CRITICALs remediated, WARNINGs skipped + reason)
- Bugbot triage summary (fixed / dismissed / needs-human)
- Any human-required items that couldn't be auto-resolved

## Error Recovery

- **Preflight failure:** Surface the specific check, exit. Do not partially run.
- **Missing skill/credential:** Exit with install/auth hint.
- **Subagent failure:** Re-dispatch with more context or implement directly.
- **Migration failure:** Fix SQL, re-run `/migrate`.
- **Validate failure:** Fix issues, re-run (max 3 retries).
- **Codex CRITICAL findings:** REMEDIATE (apply fix), push, re-review (max 2 retries). Do NOT continue past unremediated CRITICALs.
- **Bugbot findings:** `/bugbot` handles triage + fix automatically (max 3 rounds).
- **External hard-block** (TCC, network, etc.): Stop, report what was completed, surface the blocker.

## When NOT to use

- During brainstorming if you haven't approved the spec yet (this skill runs AFTER spec approval)
- For hotfixes (too heavy — just commit and push)
- When the user wants manual control over each step (use individual phase skills instead)
- When required credentials/dependencies are missing and you don't want to be told (preflight will catch them)
