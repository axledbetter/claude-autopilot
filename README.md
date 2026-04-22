# @delegance/guardrail

LLM-powered code review that catches what linters miss — security holes, logic bugs, bad auth patterns, race conditions, and architectural drift. Runs on every push, posts inline PR comments, and outputs SARIF for GitHub Code Scanning.

## What it finds

Static analysis catches style. Guardrail catches things that break in production:

- **Auth & access control** — missing middleware, broken RBAC, IDOR, privilege escalation
- **Injection & data handling** — SQL injection, XSS vectors, unsafe deserialization, hardcoded secrets
- **Logic bugs** — off-by-one, missing null checks, incorrect async handling, silent error swallowing
- **Architectural drift** — layer violations, circular dependencies, god objects, missing abstractions
- **Race conditions** — unguarded shared state, missing locks, TOCTOU
- **Security misconfig** — CORS wildcards, missing rate limits, exposed internals

Plus static rules for hygiene: npm audit, console.log, TODO/FIXME, large files, missing tests, package-lock drift.

## Install

```bash
npm install -g @delegance/guardrail
```

**Requires:** Node 22+, an LLM API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `GROQ_API_KEY`).

## Quick Start

```bash
# One command — auto-detects stack, writes config, installs pre-push hook
npx guardrail setup

# Review git-changed files before a PR
npx guardrail run --base main

# Scan any path without needing git changes
npx guardrail scan src/auth/

# Ask a targeted question about your code
npx guardrail scan --ask "is there an IDOR vulnerability in this route?" src/api/users/
```

## Claude Code Skill

Ships a ready-made Claude Code skill. After installing, copy it into your project:

```bash
mkdir -p .claude/skills
cp node_modules/@delegance/guardrail/skills/guardrail.md .claude/skills/
```

Claude agents will automatically invoke guardrail before PRs, interpret findings, and auto-fix blocking issues.

## Commands

### `guardrail run` — review git-changed files

```bash
npx guardrail run                          # diff against HEAD~1
npx guardrail run --base main              # diff against a branch
npx guardrail run --diff                   # send hunks only (~70% fewer tokens)
npx guardrail run --delta                  # only report new findings since last run
npx guardrail run --post-comments          # post summary comment on open PR
npx guardrail run --inline-comments        # post per-line inline PR annotations
npx guardrail run --format sarif --output guardrail.sarif
```

### `guardrail scan` — review any path

```bash
npx guardrail scan src/auth/               # scan a directory
npx guardrail scan src/api/users.ts        # scan specific files
npx guardrail scan --all                   # scan entire codebase
npx guardrail scan --ask "is there SQL injection risk?" src/db/
npx guardrail scan --focus security        # security findings only
npx guardrail scan --focus logic           # logic bugs only
```

`scan` doesn't require git changes — point it at anything.

### `guardrail ci` — opinionated CI entrypoint

```bash
npx guardrail ci          # base=GITHUB_BASE_REF, posts PR comment, writes SARIF
npx guardrail ci --base develop
npx guardrail ci --no-post-comments
```

### `guardrail fix` — auto-fix cached findings

```bash
npx guardrail fix                          # fix critical findings
npx guardrail fix --severity all           # fix everything
npx guardrail fix --dry-run                # preview changes
```

### `guardrail watch` — dev loop

```bash
npx guardrail watch
npx guardrail watch --debounce 500
```

### `guardrail costs` — usage summary

```bash
npx guardrail costs                        # all-time + 7-day summary + last 10 runs
```

### `guardrail autoregress` — snapshot regression

```bash
npx guardrail autoregress generate   # generate baselines for changed files
npx guardrail autoregress run        # run impact-selected snapshots
npx guardrail autoregress run --all  # run all snapshots
npx guardrail autoregress diff       # show diffs vs baselines
npx guardrail autoregress update     # overwrite baselines after intentional change
```

### `guardrail setup` / `guardrail doctor` / `guardrail hook`

```bash
npx guardrail setup            # auto-detect stack, write config, install hook
npx guardrail doctor           # check prerequisites
npx guardrail hook install     # install pre-push git hook
npx guardrail hook uninstall
```

## Config (`guardrail.config.yaml`)

```yaml
configVersion: 1
reviewEngine:
  adapter: auto        # auto-selects best available key at runtime
testCommand: npm test  # null to disable
protectedPaths:
  - data/deltas/**
  - .github/workflows/**
staticRules:
  - hardcoded-secrets
  - npm-audit
  - console-log
  - todo-fixme
  - large-file
  - missing-tests
ignore:
  - src/legacy/**                              # suppress all findings in path
  - { rule: console-log, path: scripts/** }    # suppress specific rule in path
```

### Review Engine Adapters

| Adapter | Key required | Notes |
|---|---|---|
| `auto` | any | Auto-selects best available (recommended) |
| `claude` | `ANTHROPIC_API_KEY` | Claude Opus 4.7 |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini 2.5 Pro, 1M context |
| `codex` | `OPENAI_API_KEY` | GPT-5 Codex |
| `openai-compatible` | configurable | Groq, Ollama, Together AI, etc. |

`auto` priority: Anthropic → Gemini → OpenAI → Groq.

**Groq (fast/free tier):**
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
- uses: axledbetter/guardrail/.github/actions/ci@main
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Runs the pipeline, uploads SARIF to GitHub Code Scanning, annotates the PR diff inline.

## Interpreting Results

**Exit 0** — pass or warnings only. Safe to merge.
**Exit 1** — critical findings. Fix before merging.

Findings: `critical` blocks merge · `warning` should fix · `note` informational.

PR comments show: status badge, phase table, critical/warning findings, cost footer. Re-runs update the existing comment.

## Architecture

Four pluggable adapter points:

| Point | Built-in | Purpose |
|---|---|---|
| `review-engine` | `auto`, `claude`, `gemini`, `codex`, `openai-compatible` | LLM review |
| `vcs-host` | `github` | PR comments + SARIF |
| `migration-runner` | `supabase` | DB migrations |
| `review-bot-parser` | `cursor` | Parse review bot comments |

## License

MIT
