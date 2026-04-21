# claude-autopilot

End-to-end Claude Code pipeline: approved spec → plan → worktree → implementation → migrations → validation → PR → review engine → review-bot triage.

**Status: v1.0.0-alpha.1** — core architecture in place, ported adapters (codex, github, supabase, cursor), 1 preset (nextjs-supabase), 32 passing tests. API may change through alpha.

Full design spec: `docs/superpowers/specs/2026-04-20-claude-autopilot-v1-design.md`
Implementation plans: `docs/superpowers/plans/`

## Changes in v1.0 (alpha.1)

- Four pluggable integration points (ReviewEngine, VcsHost, MigrationRunner, ReviewBotParser) with shared `AdapterBase`
- YAML config (`autopilot.config.yaml`) replaces `.autopilot/stack.md`
- Unified `Finding` type across validate + review-bot, with separate `TriageRecord[]` / `FixAttempt[]` history
- Merged static-rules phase with global re-check after autofix
- `AutopilotError` taxonomy with per-code retry policy
- `apiVersion` + `getCapabilities()` on every adapter
- Real tests phase — runs `testCommand` from config, emits critical finding on failure
- NDJSON event log with secret redaction

## Prerequisites

- Node 22+
- `gh` CLI authenticated
- `OPENAI_API_KEY` in `.env.local`

## Install

```bash
npm install --save-dev @delegance/claude-autopilot@alpha
```

## Usage (alpha.1)

CLI surface is limited to `preflight` in alpha.1. `run`, `init`, `validate`, `codex-pr-review`, `bugbot` land in alpha.4.

```bash
npx autopilot          # runs preflight
```

## Preset quick-start

```bash
cp presets/nextjs-supabase/autopilot.config.yaml .
# Edit adapters / protectedPaths / testCommand as needed
npx tsx src/cli/preflight.ts
```

## Roadmap

- **alpha.2:** chunking, cost, cache, remaining adapters, 5 presets, 20 scenario tests
- **alpha.3:** idempotency wiring, concurrency, adapter trust, 60 conformance + 13 safety tests
- **alpha.4:** full CLI (init, install-github-action, run --resume, etc.) + programmatic API
- **beta → 1.0.0:** dogfood + npm publish

## License

MIT.
