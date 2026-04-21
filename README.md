# @delegance/claude-autopilot

Automated code review pipeline for Claude Code. Runs static rules, an optional LLM review engine, and impact-aware snapshot regression tests — outputs SARIF for GitHub Code Scanning, inline PR annotations, and a pre-push hook for local enforcement.

## Install

```bash
npm install @delegance/claude-autopilot
```

Requires Node 22+. Also requires `gh` CLI authenticated and `claude` CLI installed (Claude Code).

## Quick Start

```bash
# One command — auto-detects project type, writes config, installs hook
npx autopilot setup

# Then run your first pipeline
npx autopilot run
```

Requires Node 22+, `gh` CLI authenticated, `claude` CLI (Claude Code).

## Commands

### `autopilot run`

Runs the pipeline on git-changed files vs the base ref.

```bash
npx autopilot run                        # diff against HEAD~1
npx autopilot run --base main            # diff against main
npx autopilot run --files src/foo.ts     # explicit file list
npx autopilot run --format sarif --output results.sarif
npx autopilot run --dry-run              # show what would run, no execution
```

### `autopilot watch`

Debounced re-run on every file save.

```bash
npx autopilot watch
npx autopilot watch --debounce 500
```

### `autopilot hook`

Manages a `pre-push` git hook that runs snapshot regression tests before every push.

```bash
npx autopilot hook install          # write .git/hooks/pre-push
npx autopilot hook install --force  # overwrite existing
npx autopilot hook uninstall        # remove
npx autopilot hook status           # show installed hook content
```

Works in git worktrees (handles `.git` as a file pointer).

### `autopilot autoregress`

Impact-aware snapshot regression testing. Only fires tests whose source modules (or one-hop importers) were touched by the current branch.

```bash
npx autopilot autoregress run              # impact-selected snapshots (default)
npx autopilot autoregress run --all        # all snapshots
npx autopilot autoregress diff             # show JSON diffs vs baselines
npx autopilot autoregress update           # overwrite baselines with current output
npx autopilot autoregress generate         # LLM-generate snapshot tests for changed files
npx autopilot autoregress generate --files src/foo.ts,src/bar.ts
```

Requires `OPENAI_API_KEY` for `generate` mode.

### `autopilot setup`

Zero-prompt setup: auto-detects project type, writes config, installs git hook in one command.

```bash
npx autopilot setup            # Auto-detect project, write config, install hook
npx autopilot setup --force    # Overwrite existing autopilot.config.yaml
```

Auto-detection supports: Go, Rails, FastAPI, T3, Next.js+Supabase.

### `autopilot init`

Scaffolds `autopilot.config.yaml` from a preset.

```bash
npx autopilot init
```

Available presets: `nextjs-supabase`, `t3`, `python-fastapi`, `rails-postgres`, `go`.

### `autopilot preflight`

Checks prerequisites (Node version, `gh` CLI auth, `OPENAI_API_KEY`).

## GitHub Actions

Add to your workflow:

```yaml
- uses: axledbetter/claude-autopilot@v1
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Runs the pipeline, uploads SARIF to GitHub Code Scanning, and annotates the PR diff inline.

## SARIF Output

```bash
npx autopilot run --format sarif --output autopilot.sarif
```

Compatible with `github/codeql-action/upload-sarif@v3`.

## Config (`autopilot.config.yaml`)

```yaml
preset: nextjs-supabase          # inherit a base config
reviewEngine:
  adapter: codex
  options:
    model: gpt-5.3-codex
testCommand: npm test
protect:
  - src/core/**
  - data/deltas/**
```

## Snapshot Regression Testing

After each feature lands, generate behavioral baselines:

```bash
npx autopilot autoregress generate
```

Future PRs automatically fail if covered behavior diverges. The impact selector uses `git merge-base` diff + one-hop import graph expansion so only relevant snapshots run — keeping CI token-efficient.

High-impact paths (`src/core/pipeline/**`, `src/adapters/**`, `src/core/findings/**`, `src/core/config/**`) always trigger a full run.

## Architecture

Four pluggable adapter points:

| Point | Built-in | Purpose |
|---|---|---|
| `review-engine` | `codex` | LLM code review |
| `vcs-host` | `github` | PR comments + SARIF upload |
| `migration-runner` | `supabase` | DB migration execution |
| `review-bot-parser` | `cursor` | Parse review bot comments |

## Requirements

- Node ≥ 22
- `OPENAI_API_KEY` (optional — review engine and `autoregress generate` only)
- `gh` CLI authenticated (optional — PR creation / vcs-host adapter)

## License

MIT
