# PR Description Generation Design

## Goal

`guardrail pr-desc` generates a PR title, summary, and test plan from the current diff and cached findings. Output is ready to paste or post directly via `gh pr create`.

## Design

### Commands

```bash
guardrail pr-desc                  # generate from git diff vs upstream + cached findings
guardrail pr-desc --base main      # diff against specific branch
guardrail pr-desc --post           # create the PR via gh cli (prompts for confirmation)
guardrail pr-desc --yes            # create the PR without confirmation
guardrail pr-desc --output pr.md   # write to file instead of stdout
```

### Input sources

1. **Git diff** — `git diff <base>...HEAD` (same resolution as `guardrail run --base`)
2. **Cached findings** — `.guardrail-cache/findings.json` (if present); summarized as bullet points
3. **Branch name** — extracted from `git rev-parse --abbrev-ref HEAD` to infer feature context

### LLM prompt

Sends to the review engine with `kind: 'pr-diff'`:

```
Generate a pull request description with three sections:

## Summary
<3-5 bullet points describing what changed and why>

## Changes
<grouped by file/area, concise>

## Test Plan
<checklist of what to verify before merging>

Branch: <branch-name>
Diff:
<git diff output, truncated to 6000 chars>

Guardrail findings in this diff:
<summarized findings list, or "None">
```

### Output format

Printed to stdout as markdown:

```
Title: feat(auth): add JWT refresh token rotation

---
## Summary
- Adds automatic JWT refresh token rotation on every successful auth
- ...

## Changes
- `src/auth/jwt.ts` — ...

## Test Plan
- [ ] Login flow issues new refresh token on each request
- [ ] ...
```

`--post` mode pipes `Title` line to `--title` and body to `--body` of `gh pr create`.

### Truncation

Git diff is truncated to 6000 chars (with `[...truncated N lines]` marker) to stay within LLM context. Findings list is limited to the top 10 by severity.

### `--post` flow

1. Generate description
2. Print to terminal
3. If `--yes` not set: prompt "Create PR with this description? [y/N]"
4. If confirmed: run `gh pr create --title "<title>" --body "<body>"`
5. Print PR URL

### Architecture

- `src/cli/pr-desc.ts` — `runPrDesc(options)` orchestrates diff collection, LLM call, output
- `src/cli/index.ts` — add `pr-desc` subcommand
- `tests/pr-desc.test.ts` — unit tests

### Tests

- Diff truncated at 6000 chars with marker
- Findings list capped at 10 entries
- `--output` writes file instead of printing
- With no cached findings: prompt includes "None" for findings section
- With empty diff: returns early with message "No changes detected"
- `--base` flag is passed through to diff command
- `--post --yes` calls `gh pr create` with generated title + body (mock gh call)

## Out of Scope

- Multi-PR batch generation
- Jira/Linear ticket linking
- Emoji in output
- Template customization (v2)
