# @delegance/guardrail — Renamed

**This package has been renamed to [@delegance/claude-autopilot](https://www.npmjs.com/package/@delegance/claude-autopilot).**

`@delegance/guardrail@5.0.0` is a tombstone — installing it gives you a thin forwarding wrapper that invokes `claude-autopilot` under the hood. Child stdio, argv, exit code, and signals are passed through unchanged. The wrapper emits one deprecation line on stderr before spawning the child (suppress with `CLAUDE_AUTOPILOT_DEPRECATION=never`).

## What happened

v4's `@delegance/guardrail` sold itself as "LLM code review." The real product is a full autonomous development pipeline (brainstorm → spec → plan → implement → migrate → validate → PR → review). Guardrail became one phase of that pipeline in v5. The rename makes the package and product identity match.

## Migrate to `@delegance/claude-autopilot`

```bash
npm install -g @delegance/claude-autopilot@alpha
npx @delegance/claude-autopilot migrate-v4 --write
```

The codemod rewrites `package.json`, shell scripts, GitHub Actions yaml, and Dockerfiles to reference the new name. Backup files are preserved for `--undo`.

Full migration guide: [docs/migration/v4-to-v5.md](https://github.com/axledbetter/claude-autopilot/blob/master/docs/migration/v4-to-v5.md)

## Timeline

- `@delegance/guardrail@4.3.1` — last v4 release. Still functional, still supported for critical security fixes.
- `@delegance/guardrail@5.0.0` (this package) — forwarding wrapper. Maintained through v5.x, removed in v6 (not before 2027-Q1).
- `@delegance/claude-autopilot@5.x` — canonical package name from v5 onward.
