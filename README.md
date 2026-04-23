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

Plus built-in static rules that run before the LLM: `hardcoded-secrets`, `npm-audit`, `sql-injection`, `missing-auth`, `ssrf`, `insecure-redirect`, `console-log`, `todo-fixme`, `large-file`, `missing-tests`, `package-lock-sync`, `brand-tokens`.

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

---

## Commands

### `guardrail run` — review git-changed files

```bash
npx guardrail run                          # diff against HEAD~1
npx guardrail run --base main              # diff against a branch
npx guardrail run --diff                   # send hunks only (~70% fewer tokens)
npx guardrail run --delta                  # only report findings new since last run
npx guardrail run --new-only               # only report findings not in committed baseline
npx guardrail run --fail-on warning        # exit 1 on warnings too (default: critical only)
npx guardrail run --fail-on none           # never exit 1 — soft mode for onboarding
npx guardrail run --post-comments          # post summary comment on open PR
npx guardrail run --inline-comments        # post per-line inline PR annotations
npx guardrail run --format sarif --output guardrail.sarif
npx guardrail run --format junit --output results.xml   # JUnit XML for Jenkins/GitLab CI
```

### `guardrail scan` — review any path

```bash
npx guardrail scan src/auth/               # scan a directory
npx guardrail scan src/api/users.ts        # scan specific files
npx guardrail scan --all                   # scan entire codebase
npx guardrail scan --ask "is there SQL injection risk?" src/db/
npx guardrail scan --focus security        # security findings only
npx guardrail scan --focus logic           # logic bugs only
npx guardrail scan --focus brand           # brand consistency only
```

`scan` doesn't require git changes — point it at anything.

### `guardrail fix` — auto-fix cached findings

```bash
npx guardrail fix                          # fix critical findings (interactive)
npx guardrail fix --severity all           # fix everything
npx guardrail fix --yes                    # apply all fixes without prompting
npx guardrail fix --dry-run                # list what would be fixed, no LLM needed
```

When `testCommand` is set in config, each fix is **verified**: the patch is applied, tests run, and the fix is **automatically reverted** if tests fail. Use `--no-verify` to skip test verification.

### `guardrail baseline` — commit a finding snapshot

Pin the current findings so future runs only surface *new* issues:

```bash
npx guardrail baseline create              # create initial baseline
npx guardrail baseline update              # overwrite with current findings
npx guardrail baseline show                # print all pinned entries
npx guardrail baseline diff                # what's new vs baseline, what's resolved
npx guardrail baseline clear               # remove baseline file
npx guardrail baseline create --note "post-audit clean state"
```

After creating: `git add .guardrail-baseline.json && git commit` to share with the team. Then run with `--new-only` to suppress baselined findings in CI.

### `guardrail triage` — mark findings as accepted or false positives

```bash
npx guardrail triage <finding-id> false-positive
npx guardrail triage <finding-id> accepted-risk --reason "mitigated by WAF"
npx guardrail triage <finding-id> accepted-risk --expires 30   # auto-expire in 30 days
npx guardrail triage list                  # show all triaged findings
npx guardrail triage clear <finding-id>    # remove a triage entry
npx guardrail triage clear --expired       # prune expired entries
```

Triaged findings are suppressed automatically on every subsequent run. Commit `.guardrail-triage.json` to share decisions with the team. Finding IDs appear in `guardrail report` output.

### `guardrail report` — markdown report from cached findings

```bash
npx guardrail report                       # print to stdout
npx guardrail report --output report.md    # write to file
npx guardrail report --trend               # include run history + cost trend
```

### `guardrail explain` — deep-dive on a finding

```bash
npx guardrail explain                      # list cached findings with indices
npx guardrail explain 3                    # explain finding #3
npx guardrail explain src/auth/login.ts:42 # explain by file:line
npx guardrail explain hardcoded-secrets    # explain by rule id
```

Returns five structured sections: **What this is**, **Why it's dangerous**, **How to fix it**, **Before/after example**, **When to suppress**.

### `guardrail ignore` — suppress findings permanently

```bash
npx guardrail ignore                       # step through cached findings, add rules
npx guardrail ignore --all                 # suppress all (rule+path scope)
npx guardrail ignore --dry-run             # preview rules without writing
```

Writes entries to `.guardrail-ignore`. Scoped to path or rule+path — more targeted than triage.

### `guardrail ci` — opinionated CI entrypoint

```bash
npx guardrail ci          # base=GITHUB_BASE_REF, posts PR comment, writes SARIF
npx guardrail ci --base develop
npx guardrail ci --no-post-comments
npx guardrail ci --fail-on warning
```

### `guardrail pr` — review a pull request by number

```bash
npx guardrail pr 42                        # review PR #42 with inline + summary comments
npx guardrail pr                           # auto-detect PR from current branch
npx guardrail pr 42 --no-inline-comments
npx guardrail pr 42 --no-post-comments
```

Requires `gh` CLI authenticated.

### `guardrail costs` — usage summary

```bash
npx guardrail costs                        # all-time + 7-day summary + last 10 runs
```

### `guardrail watch` — dev loop

```bash
npx guardrail watch
npx guardrail watch --debounce 500
```

### `guardrail autoregress` — snapshot regression tests

```bash
npx guardrail autoregress generate   # generate baselines for changed files
npx guardrail autoregress run        # run impact-selected snapshots
npx guardrail autoregress run --all  # run all snapshots
npx guardrail autoregress diff       # show diffs vs baselines
npx guardrail autoregress update     # overwrite baselines after intentional change
```

### `guardrail setup` / `guardrail doctor` / `guardrail hook`

```bash
npx guardrail setup                        # auto-detect stack, write config, install hook
npx guardrail setup --profile security-strict   # apply a security-focused config bundle
npx guardrail setup --profile team              # standard team config
npx guardrail setup --profile solo             # minimal solo-dev config
npx guardrail doctor                       # check prerequisites
npx guardrail hook install                 # install pre-push git hook
npx guardrail hook uninstall
```

---

## Config (`guardrail.config.yaml`)

```yaml
configVersion: 1
reviewEngine:
  adapter: auto        # auto-selects best available key at runtime
testCommand: npm test  # null to disable; used by `fix` verified mode

protectedPaths:
  - data/deltas/**
  - .github/workflows/**

staticRules:
  - hardcoded-secrets   # Anthropic, OpenAI, Stripe, GitHub, Supabase, Twilio, SendGrid
  - npm-audit
  - sql-injection       # template literals / concatenation in SQL context
  - missing-auth        # Next.js/pages API routes with POST/PUT/DELETE, no auth pattern
  - ssrf                # HTTP calls with user-controlled URL
  - insecure-redirect   # redirect() with user-controlled target
  - console-log
  - todo-fixme
  - large-file
  - missing-tests
  - package-lock-sync
  - brand-tokens        # opt-in: requires brand: block below

# Brand token enforcement (opt-in — omit to disable)
brand:
  colorsFrom: tailwind.config.ts   # auto-extract theme.colors as canonical palette
  colors:                          # explicit palette entries (merged with colorsFrom)
    - '#f97316'
    - '#1a1f3a'
  fonts:
    - 'Inter'
    - 'Geist'

policy:
  failOn: critical      # critical (default) | warning | note | none
  newOnly: false        # true = suppress findings present in .guardrail-baseline.json

cost:
  maxPerRun: 0.50       # abort review phase if spend exceeds $0.50
  estimateBeforeRun: false  # print token estimate before LLM calls

ignore:
  - src/legacy/**                              # suppress all findings in path
  - { rule: console-log, path: scripts/** }    # suppress specific rule in path

chunking:
  rateLimitBackoff: exp    # exp (default) | linear | none
  parallelism: 3
```

### Setup Profiles

`guardrail setup --profile <name>` overlays a pre-baked rule + policy configuration on top of the detected stack preset:

| Profile | Rules | `failOn` | Best for |
|---|---|---|---|
| `security-strict` | All security rules + hygiene | `warning` | Security audits, regulated environments |
| `team` | Core security + hygiene | `critical` | Standard CI/CD on shared branches |
| `solo` | Hygiene only | `critical` | Solo projects, low-noise baseline |

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

---

## GitHub Actions

```yaml
- uses: axledbetter/claude-autopilot/.github/actions/ci@main
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    # Optional:
    # post-comments: 'true'
    # inline-comments: 'false'
    # base-ref: 'main'
    # sarif-output: 'guardrail.sarif'
    # version: 'latest'
```

Runs the pipeline, uploads SARIF to GitHub Code Scanning, annotates the PR diff inline.

---

## Typical Team Workflow

```bash
# 1. First run — establish a baseline so CI only fails on new issues
npx guardrail run --base main
npx guardrail baseline create --note "post-v2 audit"
git add .guardrail-baseline.json && git commit -m "chore: guardrail baseline"

# 2. CI — only new findings block the build
npx guardrail ci --new-only --fail-on critical

# 3. Triage false positives once, never see them again
npx guardrail triage sql-injection:src/db/raw.ts:47 false-positive --reason "internal admin only"
git add .guardrail-triage.json && git commit -m "chore: triage false positive"

# 4. Auto-fix and verify
npx guardrail fix --yes   # applies patches + runs tests, reverts on failure
```

---

## Interpreting Results

**Exit 0** — pass or warnings only (at current `policy.failOn` threshold). Safe to merge.  
**Exit 1** — findings at or above threshold. Fix before merging.

Findings: `critical` blocks merge · `warning` should fix · `note` informational.

PR comments show: status badge, phase table, critical/warning findings with inline links, cost footer. Re-runs update the existing comment in place.

---

## Architecture

Four pluggable adapter points:

| Point | Built-in | Purpose |
|---|---|---|
| `review-engine` | `auto`, `claude`, `gemini`, `codex`, `openai-compatible` | LLM review |
| `vcs-host` | `github` | PR comments + SARIF |
| `migration-runner` | `supabase` | DB migrations |
| `review-bot-parser` | `cursor` | Parse review bot comments |

**Monorepo:** Auto-detects npm/yarn/pnpm workspaces, Turborepo, and Nx.

## License

MIT
