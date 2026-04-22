---
name: guardrail
description: LLM-powered code review that catches security holes, logic bugs, bad auth patterns, and architectural drift — not just linting. Use before any PR, after completing a feature, or to audit any path with `scan`.
---

# guardrail — LLM Code Review

Catches what linters miss: security holes, broken auth, logic bugs, race conditions, injection risks, architectural drift. Runs static rules for hygiene, then sends code to an LLM reviewer that understands context. Outputs SARIF for GitHub Code Scanning, posts inline PR comments, and has a pre-push hook for local enforcement.

## When to Use

- Before creating a PR: `npx guardrail run --base main`
- To audit any path without needing git changes: `npx guardrail scan src/auth/`
- To ask a targeted question about code: `npx guardrail scan --ask "is there an IDOR here?" src/api/`
- Inside CI: `npx guardrail ci`
- Dev loop: `npx guardrail watch`
- First setup: `npx guardrail setup && npx guardrail doctor`

## Prerequisites

```bash
npx guardrail doctor   # checks Node 22+, tsx, gh CLI, API key, git config
```

## Commands

### `run` — review git-changed files

```bash
npx guardrail run                          # diff HEAD~1 (default)
npx guardrail run --base main              # diff against branch
npx guardrail run --files src/a.ts,src/b.ts  # explicit files
npx guardrail run --dry-run                # show what would run
npx guardrail run --diff                   # send hunks only (~70% fewer tokens)
npx guardrail run --delta                  # only new findings since last run
npx guardrail run --post-comments          # post/update summary on open PR
npx guardrail run --inline-comments        # post per-line inline PR annotations
npx guardrail run --format sarif --output guardrail.sarif
```

### `scan` — review any path (no git required)

```bash
npx guardrail scan src/auth/               # scan a directory
npx guardrail scan src/api/users.ts        # scan specific files
npx guardrail scan --all                   # scan entire codebase
npx guardrail scan --ask "is there SQL injection risk?" src/db/
npx guardrail scan --ask "any IDOR vulnerabilities?" src/api/
npx guardrail scan --focus security src/   # security findings only
npx guardrail scan --focus logic src/      # logic bugs only
npx guardrail scan --dry-run src/auth/     # list files without running
```

`scan` doesn't require git changes — use it to audit existing code, review a directory before merge, or answer a specific question about the codebase.

### `ci` — opinionated CI entrypoint

```bash
npx guardrail ci          # base=GITHUB_BASE_REF, post-comments=true, sarif written
npx guardrail ci --base develop
npx guardrail ci --no-post-comments
npx guardrail ci --output results.sarif
```

### `fix` — auto-fix cached findings

```bash
npx guardrail fix                          # fix critical findings
npx guardrail fix --severity all           # fix everything
npx guardrail fix --dry-run                # preview fixes
```

### `watch` — dev loop

```bash
npx guardrail watch
npx guardrail watch --debounce 500
```

### `costs` — usage summary

```bash
npx guardrail costs   # all-time + 7-day + last 10 runs
```

### `autoregress` — snapshot regression

```bash
npx guardrail autoregress generate   # create baselines for changed files
npx guardrail autoregress run        # run impact-selected snapshots
npx guardrail autoregress run --all  # run all snapshots
npx guardrail autoregress diff       # show diffs vs baselines
npx guardrail autoregress update     # overwrite baselines after intentional change
```

### `hook` — pre-push git hook

```bash
npx guardrail hook install
npx guardrail hook uninstall
npx guardrail hook status
```

## LLM Review Adapters

Configure via `reviewEngine.adapter` in `guardrail.config.yaml`:

| Adapter | Key env var | Notes |
|---------|-------------|-------|
| `auto` | any | Picks available provider; prefers the one already used in code |
| `claude` | `ANTHROPIC_API_KEY` | Claude Opus 4.7 |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini 2.5 Pro, 1M context |
| `codex` | `OPENAI_API_KEY` | gpt-5.3-codex via responses API |
| `openai-compatible` | configurable | Any OpenAI-API endpoint (Groq, Ollama, Together) |

## What the LLM Catches

Beyond static rules, the LLM review looks for:

- **Auth & access control** — missing middleware, broken RBAC, IDOR, privilege escalation paths
- **Injection risks** — SQL injection, XSS vectors, unsafe deserialization, path traversal
- **Secrets & data exposure** — API keys in logs, PII in error messages, overly broad queries
- **Logic bugs** — incorrect conditionals, off-by-one errors, wrong comparison operators, missed edge cases
- **Async errors** — unhandled promises, race conditions, missing awaits, callback hell
- **Architectural drift** — layer violations, tightly coupled modules, missing abstractions

## Config (`guardrail.config.yaml`)

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
  - console-log
  - todo-fixme
  - large-file
  - missing-tests
ignore:
  - src/legacy/**
  - { rule: console-log, path: scripts/** }
```

## Integration with Development Pipeline

```bash
# After implementing a feature
npx guardrail run --base main

# Or audit the new auth module specifically
npx guardrail scan src/auth/ --focus security

# If findings → fix → re-run
npx guardrail fix
npx guardrail run --base main

# If clean → push → create PR
```
