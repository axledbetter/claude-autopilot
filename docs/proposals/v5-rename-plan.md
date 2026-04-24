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

## Estimated effort

| Task | Hours |
|---|---|
| package.json + bin wiring | 1 |
| CLI verb restructure | 3 |
| Skills bundling + init provisioner | 3 |
| README replacement | 1 |
| New `claude-autopilot.md` skill spec | 2 |
| Tombstone package publish | 1 |
| Alpha soak against delegance-app (2 real features) | 4-6 |
| **Total** | **15-17 hours across a few sessions** |

## Open questions for Alex

1. **Are the pipeline skills fit to bundle?** Today's `migrate` skill is Supabase-specific and references Delegance-specific paths (`data/deltas/`, `types/supabase.ts`). Either generalize it (parametrize DB + type-gen command) or ship it as an opinionated "Supabase stack" preset and offer a no-op `migrate` for other stacks.
2. **Superpowers dependency.** The `autopilot` skill requires `superpowers:writing-plans`, `superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`. Do we bundle equivalents, vendor them, or require the superpowers plugin as a peer?
3. **Does `claude-autopilot review --fix --verify` survive the cut?** It's one of the top-3 differentiators but implementation lives inside several files. Worth a pre-v5 pass to make it first-class with its own integration tests.
4. **Do we want a hosted option?** Not for v5, but worth deciding before v6. Today claude-autopilot is local-only by design; if that's a moat, keep it. If it's a limitation, a "Delegance Cloud" tier is the natural v6 move.
