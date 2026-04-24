# Spec — v5 pipeline rename (`@delegance/guardrail` → `@delegance/claude-autopilot`)

**Date:** 2026-04-24
**Status:** Approved (Codex 5.3 reviewed, one round of revisions landed in `docs/proposals/`)
**Target release:** `5.0.0-alpha.1` this sprint, `5.0.0` GA after alpha soak against `delegance-app`.

## Problem

`@delegance/guardrail@4.3.1` is distributed as "LLM-powered code review" — the least differentiated phase of a full autonomous development pipeline. An external cold-start reviewer and `/codex-review` both confirm: the identity fracture (npm name vs repo vs product) costs credibility, directs reviewers at the wrong competitive set (CodeRabbit / BugBot / Copilot Review), and hides the actual moat (opinionated, local, multi-model, skill-per-phase pipeline — closer to Devin / Copilot Workspace / Factory / OpenHands).

The pipeline skills (`autopilot`, `migrate`, `validate`, `codex-review`, `bugbot`, `council`, `review-2pass`, `commit-push-pr`) exist in-repo but **don't ship in the npm tarball**. Today's `@delegance/guardrail@4.3.1` tarball contains exactly one skill: `skills/guardrail.md`. Users cannot run the pipeline from a plain `npx` install.

## Goal

Ship `@delegance/claude-autopilot@5.0.0-alpha.1` that:

1. Renames the package + adds `claude-autopilot` as primary CLI binary.
2. Ships all pipeline skills in the tarball.
3. Swaps README to pipeline-first positioning with competitive table benchmarked against Devin / Copilot Workspace / Factory / OpenHands.
4. Adds a `generic` preset (non-Supabase) — no-op `migrate`, inferred `validate`.
5. Preserves every v4.x invocation: `guardrail run`, `guardrail scan`, `guardrail ci` all keep working through v5.x via an aliased `guardrail` bin that emits a one-line deprecation on first use.
6. Ships migration doc + find/replace patterns for users updating their hooks, CI, Dockerfiles.

**Non-goals for alpha.1:** complete CLI verb restructure (27 → 12), v4 golden-test matrix, tombstone `@delegance/guardrail@5.0.0` package, CI smoke tests for bin parity, codemod, superpowers hard-fail in doctor. Those land in alpha.2 and alpha.3 before `5.0.0` GA.

## Design

### Package identity

```jsonc
// package.json
{
  "name": "@delegance/claude-autopilot",
  "version": "5.0.0-alpha.1",
  "bin": {
    "claude-autopilot": "bin/claude-autopilot.js",
    "guardrail":        "bin/guardrail.js"
  },
  "files": ["bin/", "src/", "presets/", "skills/", "scripts/test-runner.mjs", "scripts/autoregress.ts", "scripts/snapshots/", "tests/snapshots/", "CHANGELOG.md", "README.md"]
}
```

### Bin wrappers

Both bins resolve to the same `src/cli/index.ts` entrypoint. The `guardrail` bin emits a one-line deprecation notice on `stderr` (never `stdout`, so piped output isn't polluted) on first invocation per terminal session, then forwards unchanged.

```
// bin/guardrail.js
…emit once-per-session deprecation notice on stderr
…spawn node + tsx with same argv
```

### Skills bundled in tarball

Moving from `.claude/skills/` (repo-only) to `skills/` (shipped):

- `skills/claude-autopilot.md` — NEW. Agent-loop spec for the pipeline (not a CLI reference). Tells Claude when to invoke the pipeline, how to interpret phase outputs, when to pause, how to recover.
- `skills/autopilot/SKILL.md` — moved from `.claude/skills/autopilot/`.
- `skills/migrate/SKILL.md` — moved from `.claude/skills/migrate/`.
- `skills/guardrail.md` — KEPT as compat. Rewritten to say "alias for review phase, see `claude-autopilot.md` for the pipeline."

### Generic preset

```
presets/generic/
├── guardrail.config.yaml    # no migrationRunner, no Supabase-specific rules
└── stack.md                 # describes what the preset assumes
```

`src/cli/detector.ts` new behavior:

- Existing logic detects `nextjs-supabase`, `t3`, `rails-postgres`, `python-fastapi`, `go`.
- **New fallback:** `generic` when no signals found (currently falls back to `nextjs-supabase` with low confidence — the bug the cold-start reviewer caught).

`src/cli/setup.ts` accepts `--preset <name>` and prompts if detection is `low` confidence, unless `--preset` was explicit.

### README

Replace top ~230 lines of `README.md` with `docs/proposals/v5-readme-draft.md` content. Update every `@delegance/guardrail` reference to `@delegance/claude-autopilot`. Existing Configuration / CI integration / SARIF / cost-tuning sections stay unchanged.

### Migration doc

`docs/migration/v4-to-v5.md` — find/replace patterns for:
- `package.json` → `"@delegance/guardrail"` becomes `"@delegance/claude-autopilot"`
- Shell scripts / hooks → `guardrail run` becomes `claude-autopilot review run` (or keep `guardrail run` + accept the deprecation notice)
- GitHub Actions yaml → update `npm install` lines
- Dockerfiles → same
- Claude Code skills → copy `skills/claude-autopilot.md` in place of `skills/guardrail.md`

Include rollback notes (pin `^4.3.1` in `package.json`).

## Rollout plan (alpha.1)

1. Cut `feature/v5-rename` off master. ✓
2. Update `package.json` (name + version + bin + files).
3. Write `bin/claude-autopilot.js` (primary) and update `bin/guardrail.js` (deprecation + passthrough).
4. Move skills into `skills/` and update `package.json` files array.
5. Write new `skills/claude-autopilot.md` agent-loop spec. Rewrite `skills/guardrail.md` to alias.
6. Add `presets/generic/`. Update `detector.ts` fallback. Update `setup.ts` for `--preset` flag.
7. Swap README content from `docs/proposals/v5-readme-draft.md`.
8. Write `docs/migration/v4-to-v5.md`.
9. Update CHANGELOG with 5.0.0-alpha.1 entry.
10. Run `npm run typecheck`, `npm test`, `npm pack --dry-run`. All must pass.
11. Commit, push `feature/v5-rename`, open PR.
12. Codex review PR → fix criticals.
13. Bugbot triage PR → fix or dismiss.
14. Merge. Tag `v5.0.0-alpha.1`. Auto-publish via existing workflow.

## Deferred to later alphas

**alpha.2 (target: 1-2 weeks after alpha.1):**
- Full CLI verb restructure: `claude-autopilot {review,pr,triage,advanced}` with legacy subcommands aliased.
- v4 compatibility golden-test matrix — top 20 commands pinned with exit-code + output-shape parity.
- Superpowers peer dep + doctor hard-fail + one-command remediation.

**alpha.3 (target: 1-2 weeks after alpha.2):**
- Tombstone `@delegance/guardrail@5.0.0` published with thin CLI wrapper forwarding to `claude-autopilot`.
- CI smoke tests for bin parity: `npx guardrail`, `npx @delegance/guardrail`, global install, GitHub Actions.
- Codemod script `npx @delegance/claude-autopilot migrate-v4 [--write]` for users updating at scale.
- Deprecation notice on `@delegance/guardrail` npm.

**5.0.0 GA:** after alpha.3 soaks against delegance-app for 2+ real feature pipelines without regression.

## Success criteria for alpha.1

- `npm install -g @delegance/claude-autopilot@5.0.0-alpha.1` installs both bins.
- `claude-autopilot --help` lists the pipeline phases (even if some route to existing `guardrail` verbs).
- `guardrail run` continues to work unchanged (with deprecation notice on stderr).
- `npm pack` tarball includes `skills/{claude-autopilot.md,autopilot/,migrate/}` and `presets/generic/`.
- `npm run typecheck` clean. `npm test` 562/562 pass (same as v4.3.1 baseline).
- PR merges. Tag publishes via CI. `npm view @delegance/claude-autopilot@latest` returns `5.0.0-alpha.1`.
