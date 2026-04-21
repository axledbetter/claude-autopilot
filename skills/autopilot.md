---
name: autopilot
description: Run the @delegance/claude-autopilot code review pipeline — static rules, LLM review, snapshot regression. Use before any PR or after completing a feature.
---

# autopilot — Code Review Pipeline

Runs static rules, optional LLM review (Codex), and impact-aware snapshot regression tests on git-changed files. Outputs findings inline and optionally as SARIF for GitHub Code Scanning.

## When to Use

- Before creating a PR (catch issues before review)
- After completing a feature branch (validate the full changeset)
- Inside a CI pipeline step (use `--format sarif --output results.sarif`)
- Anytime `validate` is called in a dev pipeline

## Prerequisites

Run `npx autopilot doctor` once per project setup to verify:
- Node 22+, tsx, gh CLI authenticated, claude CLI, OPENAI_API_KEY, git user config

## Commands

### Run pipeline on changed files

```bash
# Diff against HEAD~1 (default — last commit)
npx autopilot run

# Diff against a branch (typical pre-PR use)
npx autopilot run --base main

# Explicit file list (skip git detection)
npx autopilot run --files src/foo.ts,src/bar.ts

# Dry run — show what would run, no execution
npx autopilot run --dry-run

# SARIF output for GitHub Code Scanning
npx autopilot run --format sarif --output autopilot.sarif
```

### Zero-prompt setup (new project)

```bash
npx autopilot setup
```

Auto-detects project type (Go, Rails, FastAPI, T3, Next.js+Supabase), writes `autopilot.config.yaml`, installs pre-push hook, runs doctor.

### Check prerequisites

```bash
npx autopilot doctor
```

Exits 1 if blockers found. Safe to re-run anytime.

### Watch mode (dev loop)

```bash
npx autopilot watch              # re-run on every file save
npx autopilot watch --debounce 500
```

### Snapshot regression testing

```bash
# Generate baselines for changed files (requires OPENAI_API_KEY)
npx autopilot autoregress generate

# Run only impact-selected snapshots (default — fast)
npx autopilot autoregress run

# Run all snapshots
npx autopilot autoregress run --all

# Show diffs vs baselines
npx autopilot autoregress diff

# Overwrite baselines after intentional behavior change
npx autopilot autoregress update
```

### Pre-push git hook

```bash
npx autopilot hook install       # write .git/hooks/pre-push
npx autopilot hook uninstall
npx autopilot hook status
```

## Interpreting Results

**Exit code 0** — no findings, or only warnings. Safe to proceed.

**Exit code 1** — one or more blocking findings. Fix before merging.

**Finding severities:**
- `error` — blocks merge (hardcoded secrets, npm audit Critical/High, failed tests)
- `warning` — should fix, won't block
- `info` — informational

**SARIF output** — upload to GitHub Code Scanning with `github/codeql-action/upload-sarif@v3` for inline PR annotations.

## Config (`autopilot.config.yaml`)

```yaml
configVersion: 1
reviewEngine:
  adapter: codex         # LLM review via OpenAI (requires OPENAI_API_KEY)
testCommand: npm test
protectedPaths:
  - src/core/**
staticRules:
  - hardcoded-secrets
  - npm-audit
```

Full schema and preset defaults: `node_modules/@delegance/claude-autopilot/presets/<name>/autopilot.config.yaml`

## Integration with Development Pipeline

In a full spec→PR pipeline, `autopilot run` replaces the validate step:

```bash
# After implementing feature on branch
npx autopilot run --base main

# If findings → fix → re-run (max 3 iterations)
# If clean → push → create PR
```

## GitHub Actions

```yaml
- uses: axledbetter/claude-autopilot/.github/actions/ci@main
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Runs the pipeline, uploads SARIF, annotates the PR diff inline.
