# Split Git Hooks Design

## Goal

Split `guardrail hook install` into two hooks with different speeds and scopes:

- **pre-commit** — runs only static rules (<1s), never blocks on LLM cost or latency
- **pre-push** — runs the full LLM review pipeline, same as `guardrail run --base <upstream>`

Developers get instant feedback on every commit and thorough LLM review before the push reaches CI.

## Design

### Commands

```bash
guardrail hook install            # install both pre-commit + pre-push (new default)
guardrail hook install --pre-commit-only   # static rules only
guardrail hook install --pre-push-only     # LLM review only (current behavior)
guardrail hook uninstall          # remove both hooks
guardrail hook status             # show which hooks are installed + their config
```

### pre-commit hook behavior

Runs `guardrail run --static-only` on staged files (not all changed files):

```bash
STAGED=$(git diff --cached --name-only --diff-filter=ACM | tr '\n' ' ')
npx guardrail run --static-only --files $STAGED
```

- Exits 0 on pass, 1 on critical static findings in staged files
- Never spawns LLM calls
- Skips gracefully if no staged files

### pre-push hook behavior

Runs the full review against the upstream branch being pushed to:

```bash
npx guardrail run --base $(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "HEAD~1")
```

- Same behavior as current single hook
- Exits 0 on pass, 1 on critical findings (per `policy.failOn` config)

### New CLI flag: `--static-only`

`guardrail run --static-only` skips the review-engine phase entirely. Runs only the static rules phase and exits. Used internally by the pre-commit hook.

Add to `run.ts` command options and pass through to `runGuardrail` as `skipReview: true` on `GuardrailConfig`.

### Hook file templates

Two template strings in `src/cli/hook.ts`:

```
PRE_COMMIT_TEMPLATE — the pre-commit shell script
PRE_PUSH_TEMPLATE   — the pre-push shell script (existing hook content)
```

Both templates include a `# guardrail-managed` comment so `hook uninstall` can identify and remove them safely.

### `guardrail hook status`

Reads `.git/hooks/pre-commit` and `.git/hooks/pre-push`, checks for `# guardrail-managed` marker, reports installed/not-installed for each.

### Architecture

- `src/cli/hook.ts` — add `PRE_COMMIT_TEMPLATE`, `status` subcommand, `--pre-commit-only` / `--pre-push-only` flags to `install`
- `src/cli/run.ts` — add `--static-only` flag
- `src/core/pipeline/run.ts` — add `skipReview?: boolean` to `RunOptions`; short-circuit before review phase when set
- `src/cli/index.ts` — wire `--static-only` to run command
- `tests/hook.test.ts` — unit tests for template generation, status detection, uninstall

### Tests

- `install` writes both hooks when called without flags
- `install --pre-commit-only` writes only pre-commit
- `install --pre-push-only` writes only pre-push (existing behavior)
- `uninstall` removes both hooks
- `status` correctly reports installed/not-installed for each hook
- `--static-only` flag causes review phase to be skipped
- `--static-only` with critical static finding → exit 1
- `--static-only` with no findings → exit 0

## Out of Scope

- Per-file staging detection for partial commits
- Hook configuration via `guardrail.config.yaml` (v2)
- Windows `.cmd` hook shims
