---
name: guardrail
description: (Legacy alias) LLM-powered code review — runs static rules + LLM review over git-changed files. As of v5, this is the review *phase* of claude-autopilot. Invoke via `claude-autopilot review run` or the full pipeline via `claude-autopilot` skill.
---

# guardrail — review phase (legacy alias)

As of `@delegance/claude-autopilot@5.0.0`, `guardrail` is the review phase of the full pipeline, not a standalone product. This skill is preserved as a back-compat alias for Claude Code agents that were configured against v4.x.

**For new configurations**, invoke `skills/claude-autopilot.md` to drive the full pipeline, or use the `review` subcommand directly for just the review phase.

## What it does

Static rules (`hardcoded-secrets`, `sql-injection`, `missing-auth`, `ssrf`, `insecure-redirect`, `npm-audit`, `package-lock-sync`, `console-log`, `todo-fixme`, `large-file`, `missing-tests`, `brand-tokens`, `schema-alignment`) run first, then an LLM reviewer (`claude`, `codex`, `gemini`, or `openai-compatible`) gets the code with context. Output is SARIF / JUnit / inline PR comments.

## When to use

- Before creating a PR — `claude-autopilot review run --base main`
- To audit a path without git changes — `claude-autopilot review scan src/auth/`
- To ask a targeted question — `claude-autopilot review scan --ask "is there an IDOR here?" src/api/`
- Inside CI — `claude-autopilot review ci`
- Dev loop — `claude-autopilot review watch`

## Legacy commands that still work

All v4 `guardrail <cmd>` invocations work unchanged through v5.x. A one-line deprecation notice prints on first invocation per terminal session. Migration guide: `docs/migration/v4-to-v5.md`.

```bash
guardrail run --base main        # still works — equivalent to `claude-autopilot review run --base main`
guardrail scan src/auth/         # still works
guardrail ci                     # still works
```

## What changed in v5

- `guardrail` is now one phase of a pipeline, not a standalone product.
- The full pipeline runs via the `claude-autopilot` skill or `claude-autopilot` CLI.
- Review commands are now grouped: `claude-autopilot review {run,scan,ci,explain,fix,baseline}`.
- The package is `@delegance/claude-autopilot` — the old `@delegance/guardrail` will be a thin tombstone forwarding to the new package in v5.0.0 GA.
