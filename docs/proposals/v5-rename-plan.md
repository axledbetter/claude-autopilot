# v5 rename plan — `@delegance/guardrail` → `@delegance/claude-autopilot`

**Goal:** align npm package name, CLI binary, repo name, README, and skills around the real product (the full pipeline), while keeping every v4.x user working without breakage.

**Non-goal:** a category rewrite. The code that ships works. This is a naming, packaging, and docs effort plus a handful of skill additions.

## Current identity fractures

| Surface | Says | Reality |
|---|---|---|
| npm package | `@delegance/guardrail` | One verb inside autopilot |
| Repo | `github.com/axledbetter/claude-autopilot` | Matches product, doesn't match package |
| CLI binary | `guardrail` | Runs all 27 subcommands including `autopilot`, `brainstorm`-adjacent flows |
| README hero | "LLM-powered code review" | Sells 1 of ~10 phases |
| Shipped skill | `skills/guardrail.md` (single file, CLI reference) | Full pipeline skills live only in repo `.claude/skills/`, unpublished |
| GitHub Actions snippet | References `autopilot` | Package name is `guardrail` |

Every external reviewer who lands on this package reviews "yet another AI PR reviewer." That's the least differentiated framing of the work.

## Decision: release as v5.0.0 with a three-part rename

### Part 1 — Package rename (breaking, SemVer-major)

- Publish **new** `@delegance/claude-autopilot@5.0.0` with the full pipeline positioning.
- Publish **tombstone** `@delegance/guardrail@5.0.0` that prints a deprecation banner and re-exports the `review` surface from `claude-autopilot` (so `npx guardrail run` keeps working for one minor cycle).
- Deprecate `@delegance/guardrail` on npm: `npm deprecate @delegance/guardrail "Renamed to @delegance/claude-autopilot"`.
- The 4.x line gets one more release — `@delegance/guardrail@4.9.0` — containing nothing but a runtime notice pointing users at the new name. This avoids stranding anyone who pins `^4`.

### Part 2 — Binary rename

Ship **two** bins from the new package:

| Binary | Purpose | Back-compat |
|---|---|---|
| `claude-autopilot` | Primary entrypoint. Lists top-level verbs (`brainstorm`, `plan`, `implement`, `review`, `migrate`, `validate`, `pr`, `triage`). | — |
| `guardrail` | Alias for `claude-autopilot review` plus the legacy `guardrail` subcommands (`scan`, `ci`, `explain`, `baseline`, `ignore`, `costs`, `fix`). Prints a one-line deprecation notice on first invocation per session, pointing to `claude-autopilot review`. | Keeps every existing hook, CI workflow, and `npx guardrail …` invocation working through v5.x. Removed in v6. |

The 27-subcommand surface collapses behind `claude-autopilot` like this:

```
claude-autopilot
├─ brainstorm      (new — front of pipeline)
├─ plan            (new — writing-plans skill)
├─ implement      (new — subagent-driven-development skill)
├─ review          (was: guardrail run / scan / ci)
│   ├─ run
│   ├─ scan
│   ├─ ci
│   └─ explain
├─ migrate         (existing)
├─ validate        (existing)
├─ pr              (was: guardrail pr / pr-desc / pr-comment)
├─ triage          (was: guardrail triage / bugbot)
├─ council         (existing, promoted)
├─ costs           (existing)
├─ doctor          (existing)
├─ setup → init    (rename for consistency)
└─ advanced        (hides: worker, lsp, mcp, autoregress, test-gen, watch, hook, baseline, ignore, fix, detector)
```

`advanced` is the escape hatch for power-user commands that don't belong on the top-level help output. They all still work, just gated behind one extra word.

### Part 3 — Ship the full skill set in the package

Today the npm tarball contains `skills/guardrail.md` and nothing else. The pipeline skills (`autopilot`, `brainstorming`, `writing-plans`, `migrate`, `validate`, `codex-review`, `bugbot`, `review-2pass`, `council`, `commit-push-pr`, etc.) live in `.claude/skills/` of the repo and in Alex's user config — not distributed.

This is the biggest gap. A user installing `@delegance/guardrail@4.3.1` today cannot actually run the pipeline — they get one review skill and 26 CLI subcommands.

For v5:

- **Include all pipeline skills in the tarball** under `skills/`:
  - `autopilot/SKILL.md`
  - `brainstorming/SKILL.md` (or document dependency on `superpowers` plugin)
  - `writing-plans/SKILL.md` (same)
  - `migrate/SKILL.md`
  - `validate/SKILL.md`
  - `codex-review/SKILL.md`
  - `bugbot/SKILL.md`
  - `review-2pass/SKILL.md`
  - `council/SKILL.md`
  - `commit-push-pr/SKILL.md`
- **`claude-autopilot init` copies the full skill set** into the target repo's `.claude/skills/`. Before v5, `setup` just wrote a config file; now it also provisions the pipeline.
- **Document the `superpowers` dependency explicitly.** The `autopilot` skill invokes `superpowers:writing-plans`, `superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`. Either bundle equivalent skills in the package or require `superpowers` as a peer and doctor-check for it.

## Migration guide (for the README)

```md
## Migrating from `@delegance/guardrail` v4.x

All v4 commands still work in v5 — the `guardrail` binary is preserved as an alias for `claude-autopilot review` plus the legacy subcommands. You'll see a one-line deprecation notice; nothing breaks.

When you're ready:

    npm uninstall -g @delegance/guardrail
    npm install  -g @delegance/claude-autopilot

Replace `guardrail` with `claude-autopilot review` in your hooks and CI. Or keep using `guardrail` — we'll remove it in v6, which isn't planned before 2027-Q1.
```

## Concrete rollout steps

1. **Branch** `feature/v5-rename` off master.
2. **Update `package.json`:** `name: @delegance/claude-autopilot`, `version: 5.0.0-alpha.1`, add `claude-autopilot` to `bin`, keep `guardrail` in `bin` pointing at the same entrypoint with a header check.
3. **Update `bin/guardrail.js`:** detect the invocation name (`process.argv[1]`); if called as `guardrail`, emit a single-line deprecation notice then forward to the new command. If called as `claude-autopilot`, no notice.
4. **Restructure `src/cli/index.ts`:** introduce top-level verbs (`review`, `pr`, `triage`, `advanced`), route legacy subcommands through them.
5. **Move `.claude/skills/*` into `skills/`** in the package tarball. Update `package.json` `files` array.
6. **Implement `claude-autopilot init`:** provision `.claude/skills/` in the target repo from the bundled skills.
7. **Replace the top of README** with `docs/proposals/v5-readme-draft.md`.
8. **Rewrite `skills/claude-autopilot.md`** as the agent-loop spec, not a CLI reference. The spec should describe when to invoke the pipeline, how to interpret phase outputs, when to pause for user approval, and how to recover from failed phases.
9. **Publish `5.0.0-alpha.1`** under the `alpha` dist-tag. Run it against the delegance-app repo for 2-3 features to find the rough edges.
10. **Publish `5.0.0`** after alpha soaks. Publish `@delegance/guardrail@5.0.0` tombstone at the same time. Deprecate `@delegance/guardrail` on npm.

## What we're explicitly not doing in v5

- Rewriting any existing code. The pipeline works. This is a repackaging.
- Changing the model defaults (Opus stays primary per user preference).
- Dropping any subcommand. Everything currently in v4 ships in v5, just some under `claude-autopilot advanced`.
- Renaming the GitHub repo. It's already `claude-autopilot`.
- Touching the CHANGELOG history. v4 entries stay.

## Revisions from Codex review (2026-04-24)

Folded in from `/codex-review` against v5.0 draft. Everything below overrides earlier sections in this doc where they conflict.

### Tombstone mechanics (bumped from implicit to blocker)

- `@delegance/guardrail@5.0.0` must ship a real thin CLI wrapper package with `bin.guardrail` that strictly forwards `argv`, `stdout`, `stderr`, and exit code to `claude-autopilot`. Not a re-export — an actual spawn-and-pipe.
- **CI smoke tests gate the tombstone publish:** `npx guardrail run`, `npx @delegance/guardrail run`, global `npm install -g @delegance/guardrail` + `guardrail run`, and a GitHub Actions invocation of `guardrail run` must all produce byte-identical stdout and matching exit codes vs `claude-autopilot review run`.
- Tombstone wrapper emits a one-line deprecation notice on `stderr` (not `stdout`, so piped output isn't corrupted) on first invocation per terminal session.

### Surface-area collapse (narrower cut than original plan)

Codex flagged that burying `fix` and `baseline` under `advanced` would regress UX for current power users. Revised map:

```
claude-autopilot
├─ brainstorm | plan | implement                 (pipeline entry points)
├─ review                                        (was: guardrail run / scan / ci)
│   ├─ run | scan | ci | explain
│   ├─ fix           (kept top-level — frequently used)
│   └─ baseline      (kept top-level — frequently used)
├─ migrate | validate | pr | triage | council | costs | doctor | init
└─ advanced
    ├─ lsp | mcp | worker | autoregress         (niche / system)
    ├─ test-gen | watch | hook | detector       (dev-loop)
    └─ ignore                                   (used via config more than CLI)
```

Net: 27 subcommands collapse to ~12 top-level verbs (up from planned ~10), `advanced` holds 9 niche/system commands. Still a readable `--help`, no UX regression for existing workflows.

### v4 compatibility golden-test matrix (new v5.0 gate)

Before `5.0.0` ships (alpha or GA), add `tests/v4-compat/` with golden tests that pin:

- **Top 20 v4 CLI invocations** — `guardrail run`, `guardrail run --base main`, `guardrail run --diff`, `guardrail scan src/auth/`, `guardrail scan --ask "..." src/`, `guardrail ci`, `guardrail setup`, `guardrail doctor`, `guardrail costs`, `guardrail explain 3`, `guardrail baseline`, `guardrail ignore`, `guardrail fix --dry-run`, `guardrail hook install`, `guardrail run --format sarif --output -`, `guardrail run --post-comments`, `guardrail run --inline-comments`, `guardrail pr-desc`, `guardrail report`, `guardrail run --fail-on warning`.
- **Exit codes** for each invocation against a known fixture repo.
- **Output shape** — SARIF / JUnit / annotations format parity (hash of normalized output against baseline).
- **Config acceptance** — every v4 `guardrail.config.yaml` pattern loads without AJV rejection under v5.

Regression of any of these blocks `5.0.0`. Test matrix lives in-repo and runs in CI on every PR.

### Generic preset (promoted from v5.1 to v5.0)

Codex: shipping only a Supabase-coupled `migrate` as default breaks trust for non-Supabase users at first-run. Revision:

- **`presets/generic/`** ships in v5.0 alongside the existing `presets/nextjs-supabase`. Generic preset:
  - `migrate` skill is a no-op that prints "No migration runner configured. Define one in `.claude-autopilot/stack.yaml` or use `claude-autopilot advanced configure-migrate`."
  - `validate` uses `npm test` + `npm run typecheck` + `npm run lint` if each script exists; skips otherwise with a one-line note.
  - No opinion on DB, type generation, or deployment.
- **`claude-autopilot init --preset <name>`** — user picks at setup time. `init` detects (next.js + supabase → suggests `nextjs-supabase`; otherwise → `generic`) but always asks.

### Superpowers dependency — resolved to "require as peer + doctor hard-fail" for v5.0

Codex was right that deferring this to v5.1 means "installed but won't run" on first invocation. Revised:

- `@delegance/claude-autopilot@5.0.0` declares `peerDependencies: { "@anthropic-ai/claude-code-superpowers": "*" }` (if that's the actual plugin name — verify at implementation time).
- `claude-autopilot doctor` hard-fails when the superpowers plugin skills (`superpowers:writing-plans`, `superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`) aren't resolvable from `.claude/plugins/` or `~/.claude/plugins/`.
- `claude-autopilot init` includes a one-command remediation: `npm install --save-peer @anthropic-ai/claude-code-superpowers` or the equivalent Claude Code plugin install command, printed next to the failure.
- Do NOT vendor superpowers skills — they update independently and vendoring fossilizes the dependency.

### Migration doc + codemod (new v5.0 deliverable)

Ship alongside the first `5.0.0` release:

- **`docs/migration/v4-to-v5.md`** — find/replace table covering every surface users interact with:
  - `@delegance/guardrail` → `@delegance/claude-autopilot` (package.json, package-lock.json, Dockerfiles, CI yaml, Homebrew formulas, `npx` invocations).
  - `guardrail run` → `claude-autopilot review run` (shell scripts, pre-commit hooks, GitHub Actions, Makefiles).
  - `skills/guardrail.md` → `skills/claude-autopilot.md` (`.claude/skills/` directories).
- **`scripts/migrate-v4.mjs`** — a small codemod distributed inside the package. Runs against a user's repo: scans for the find/replace patterns above, prints a report, applies with `--write`, leaves `.v4-backup` files for rollback. One-liner: `npx @delegance/claude-autopilot migrate-v4 [--write]`.
- **Blog post or GitHub Release notes** link the migration doc prominently.

### README adjustments (from Codex WARNING #2)

`v5-readme-draft.md` claims like "No other tool in this table does this" are brittle. Revise to:

- "built-in test-gated auto-revert as a first-class command" (vs "no other tool does this")
- "local execution by default; all phase artifacts on disk and editable" (vs "you can intervene — dashboard-watchers can't")
- Anchor differentiation in architecture you control (local execution, skill-level rewiring, phase artifacts), not claims about competitors' capabilities — those age fast.

## Revised effort estimate

| Task | Hours |
|---|---|
| package.json + bin wiring | 1 |
| CLI verb restructure (12 top-level + advanced) | 3 |
| Skills bundling + init provisioner | 3 |
| **Generic preset + init preset picker (new)** | 3 |
| **Superpowers dep — doctor hard-fail + remediation (promoted)** | 2 |
| README replacement | 1 |
| New `claude-autopilot.md` skill spec | 2 |
| Tombstone package + **CI smoke tests (new)** | 2 |
| **v4 compat golden-test matrix (new)** | 2 |
| **Migration doc + codemod script (new)** | 2 |
| Alpha soak against delegance-app (2 real features) | 4-6 |
| **Total** | **25-27 hours** |

## Resolved open questions

All four original questions are answered by Codex's review + Alex's "go" on 2026-04-24:

1. **`migrate` skill** → Ship as Supabase preset + ship `generic` preset in parallel (v5.0).
2. **Superpowers dep** → Peer dependency + doctor hard-fail + one-command remediation (v5.0).
3. **`review --fix --verify`** → Keep current impl in 5.0, harden + benchmark in 5.1.
4. **Hosted option** → Local-only as moat through v5. Reconsider cloud tier for v6.
