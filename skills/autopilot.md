---
name: autopilot
description: Run the @delegance/claude-autopilot code review pipeline — static rules, LLM review, snapshot regression. Use before any PR or after completing a feature.
---

# autopilot — Code Review Pipeline

Runs static rules, optional LLM review, and impact-aware snapshot regression on git-changed files. Auto-detects stack, protected paths, and test command from the project. Outputs findings inline and optionally as SARIF for GitHub Code Scanning.

## When to Use

- Before creating a PR: `npx autopilot run --base main`
- Inside CI: `npx autopilot ci` (one-command, posts PR comment + SARIF)
- Dev loop: `npx autopilot watch`
- First setup: `npx autopilot setup && npx autopilot doctor`

## Prerequisites

```bash
npx autopilot doctor   # checks Node 22+, tsx, gh CLI, API key, git config
```

## Commands

### `run` — pipeline on git-changed files

```bash
npx autopilot run                          # diff HEAD~1 (default)
npx autopilot run --base main              # diff against branch
npx autopilot run --files src/a.ts,src/b.ts  # explicit files
npx autopilot run --dry-run                # show what would run
npx autopilot run --post-comments          # post/update summary on open PR
npx autopilot run --format sarif --output autopilot.sarif
```

### `ci` — opinionated CI entrypoint

```bash
npx autopilot ci          # base=GITHUB_BASE_REF, post-comments=true, sarif written
npx autopilot ci --base develop
npx autopilot ci --no-post-comments
npx autopilot ci --output results.sarif
```

Equivalent to `run --base <ref> --post-comments --format sarif --output <path>`. Base ref resolves from `GITHUB_BASE_REF` → `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` → `HEAD~1`.

### `setup` — zero-prompt first run

```bash
npx autopilot setup         # auto-detect stack, write config, install hook
npx autopilot setup --force # overwrite existing config
```

Auto-detects: Go, Rails, FastAPI, T3, Next.js+Supabase. Runs doctor at end.

### `watch` — dev loop

```bash
npx autopilot watch
npx autopilot watch --debounce 500
```

### `autoregress` — snapshot regression

```bash
npx autopilot autoregress generate   # create baselines for changed files
npx autopilot autoregress run        # run impact-selected snapshots
npx autopilot autoregress run --all  # run all snapshots
npx autopilot autoregress diff       # show diffs vs baselines
npx autopilot autoregress update     # overwrite baselines after intentional change
```

### `hook` — pre-push git hook

```bash
npx autopilot hook install
npx autopilot hook uninstall
npx autopilot hook status
```

## LLM Review Adapters

Configure via `reviewEngine.adapter` in `autopilot.config.yaml`:

| Adapter | Key env var | Notes |
|---------|-------------|-------|
| `auto` | any | Picks available provider; prefers the one already used in code |
| `claude` | `ANTHROPIC_API_KEY` | Claude Opus 4.7 |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini 2.5 Pro, 1M context |
| `codex` | `OPENAI_API_KEY` | gpt-5.3-codex via responses API |
| `openai-compatible` | configurable | Any OpenAI-API endpoint (Groq, Ollama, Together) |

`auto` priority order: Anthropic → Gemini → OpenAI → Groq. When multiple keys are present, `auto` scans the project source files and prefers the provider already referenced most.

## Auto-Detection

When config fields are absent, `autopilot run` fills them in automatically:

- **stack** — parsed from `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, `Gemfile`; injected into review prompt
- **protectedPaths** — migration dirs (`data/deltas/`, `migrations/`, `prisma/migrations/`, etc.), schema files, infra dirs (`terraform/`, `.github/workflows/`)
- **testCommand** — re-detected at run time from project files; set `testCommand: null` to disable explicitly
- **git context** — branch + last commit injected as `Change context: branch: X | last commit: Y`

Detection lines are printed dim after the file count: `auto-detected: stack: Next.js + Supabase | protected: data/deltas/** ...`

## Interpreting Results

**Exit code 0** — pass or warnings only. Safe to proceed.
**Exit code 1** — blocking findings. Fix before merging.

Finding severities: `critical` blocks merge, `warning` should fix, `note` informational.

PR comment (via `--post-comments` or `ci`): status badge, phase table, critical/warning findings, cost footer. Edits existing comment on re-runs (tracked via `<!-- autopilot-review -->` marker).

SARIF output: upload with `github/codeql-action/upload-sarif@v3` for inline PR diff annotations. Also auto-emits `::error`/`::warning` annotations when `GITHUB_ACTIONS=true`.

## Config (`autopilot.config.yaml`)

```yaml
configVersion: 1
reviewEngine:
  adapter: auto         # auto, claude, gemini, codex, openai-compatible
testCommand: npm test   # null to disable
protectedPaths:         # auto-detected if omitted
  - data/deltas/**
  - .github/workflows/**
staticRules:
  - hardcoded-secrets
  - npm-audit
  - package-lock-sync
  - console-log
  - todo-fixme
  - large-file
  - missing-tests
```

Preset defaults at: `node_modules/@delegance/claude-autopilot/presets/<name>/autopilot.config.yaml`

## GitHub Actions

```yaml
- uses: axledbetter/claude-autopilot/.github/actions/ci@main
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # or openai/gemini/groq
```

Runs `npx autopilot ci`, uploads SARIF, annotates PR diff. All API key inputs optional — whichever is set gets used by `auto`.

## Integration with Development Pipeline

```bash
# After implementing feature
npx autopilot run --base main

# If findings → fix → re-run (max 3 iterations)
# If clean → push → create PR
```
