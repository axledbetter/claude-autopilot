# @delegance/claude-autopilot

Automated code review pipeline for Claude Code. Runs static rules, an optional LLM review engine, and impact-aware snapshot regression tests — outputs SARIF for GitHub Code Scanning, inline PR annotations, and a pre-push hook for local enforcement.

## Install

```bash
npm install @delegance/claude-autopilot
```

**Prerequisites:** Node 22+, [`gh` CLI](https://cli.github.com/) authenticated, [`claude` CLI](https://claude.ai/claude-code) (Claude Code).

## Claude Code Skill

The package ships a ready-made Claude Code skill. After installing, copy it into your project:

```bash
mkdir -p .claude/skills
cp node_modules/@delegance/claude-autopilot/skills/autopilot.md .claude/skills/
```

Claude will then know when and how to invoke `autopilot run`, interpret findings, and wire it into your dev pipeline automatically.

## Quick Start

```bash
# One command — auto-detects project type, writes config, installs hook, runs doctor
npx autopilot setup

# Run your first pipeline
npx autopilot run
```

`setup` detects your stack (Go, Rails, FastAPI, T3, Next.js+Supabase), infers your test command, writes `autopilot.config.yaml`, installs the pre-push hook, then runs `doctor` to show anything still missing.

## Commands

### `autopilot setup`

Zero-prompt setup. Auto-detects project type and configures everything.

```bash
npx autopilot setup            # detect, write config, install hook
npx autopilot setup --force    # overwrite existing autopilot.config.yaml
```

### `autopilot doctor`

Checks prerequisites. Runs automatically after `setup` — also useful any time `run` behaves unexpectedly.

```bash
npx autopilot doctor
```

Verifies: Node 22+, tsx, `gh` CLI auth, `claude` CLI, `OPENAI_API_KEY`, git user config, superpowers plugin. Exits 1 if blockers found. `autopilot preflight` is an alias.

### `autopilot run`

Runs the pipeline on git-changed files.

```bash
npx autopilot run                        # diff against HEAD~1
npx autopilot run --base main            # diff against main
npx autopilot run --files src/foo.ts     # explicit file list
npx autopilot run --format sarif --output results.sarif
npx autopilot run --dry-run
```

### `autopilot watch`

Re-runs on every file save.

```bash
npx autopilot watch
npx autopilot watch --debounce 500
```

### `autopilot autoregress`

Impact-aware snapshot regression tests. Only fires snapshots whose source modules were touched by the current branch.

```bash
npx autopilot autoregress run              # impact-selected (default)
npx autopilot autoregress run --all
npx autopilot autoregress diff             # show JSON diffs vs baselines
npx autopilot autoregress update           # overwrite baselines
npx autopilot autoregress generate         # LLM-generate snapshot tests for changed files
npx autopilot autoregress generate --files src/foo.ts,src/bar.ts
```

`generate` requires `OPENAI_API_KEY`.

### `autopilot hook`

Manages the `pre-push` git hook.

```bash
npx autopilot hook install          # write .git/hooks/pre-push
npx autopilot hook install --force  # overwrite existing
npx autopilot hook uninstall
npx autopilot hook status
```

Works in git worktrees.

### `autopilot init`

Interactive preset picker — for when you want to choose a preset manually instead of using `setup`.

```bash
npx autopilot init
```

Presets: `nextjs-supabase`, `t3`, `python-fastapi`, `rails-postgres`, `go`.

## Config (`autopilot.config.yaml`)

```yaml
configVersion: 1
reviewEngine:
  adapter: auto        # auto-detects best available key at runtime
testCommand: npm test
protectedPaths:
  - src/core/**
  - data/deltas/**
staticRules:
  - hardcoded-secrets
  - npm-audit
```

Full schema and preset defaults: `presets/<name>/autopilot.config.yaml`.

### Review Engine Adapters

| Adapter | Key required | Notes |
|---|---|---|
| `auto` | any below | Auto-selects best available (recommended) |
| `claude` | `ANTHROPIC_API_KEY` | Opus 4.7 default |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini 2.5 Pro, 1M context |
| `codex` | `OPENAI_API_KEY` | GPT-5 Codex |
| `openai-compatible` | configurable | Groq, Ollama, Together AI, etc. |

`auto` priority: Anthropic → Gemini → OpenAI → Groq.

**Groq example:**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: llama-3.3-70b-versatile
    baseUrl: https://api.groq.com/openai/v1
    apiKeyEnv: GROQ_API_KEY
```

**Ollama (local, no key):**
```yaml
reviewEngine:
  adapter: openai-compatible
  options:
    model: llama3.2
    baseUrl: http://localhost:11434/v1
```

## GitHub Actions

```yaml
- uses: axledbetter/claude-autopilot/.github/actions/ci@main
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Runs the pipeline, uploads SARIF to GitHub Code Scanning, annotates the PR diff inline.

## SARIF Output

```bash
npx autopilot run --format sarif --output autopilot.sarif
```

Compatible with `github/codeql-action/upload-sarif@v3`.

## Snapshot Regression Testing

After each feature lands:

```bash
npx autopilot autoregress generate   # generate baselines for changed files
```

Future PRs automatically fail if covered behavior diverges. The impact selector uses `git merge-base` diff + one-hop import graph expansion — only relevant snapshots run, keeping CI fast.

High-impact paths (`src/core/pipeline/**`, `src/adapters/**`, `src/core/findings/**`, `src/core/config/**`) always trigger a full run.

## Public API

```typescript
import type { Finding, RunResult, AutopilotConfig } from '@delegance/claude-autopilot';
import { normalizeSnapshot } from '@delegance/claude-autopilot';
```

Types are available for TypeScript consumers. Runtime import requires a tsx-aware bundler (the package ships TypeScript source).

## Architecture

Four pluggable adapter points:

| Point | Built-in | Purpose |
|---|---|---|
| `review-engine` | `auto`, `claude`, `gemini`, `codex`, `openai-compatible` | LLM code review |
| `vcs-host` | `github` | PR comments + SARIF upload |
| `migration-runner` | `supabase` | DB migration execution |
| `review-bot-parser` | `cursor` | Parse review bot comments |

## License

MIT
