# Migrating from `@delegance/guardrail` v4.x to `@delegance/claude-autopilot` v5

**TL;DR:** Your existing v4.x usage keeps working. The `guardrail` CLI binary is preserved through v5.x as an alias for `claude-autopilot`. You'll see a one-line deprecation notice on `stderr` (not `stdout`, so piped output isn't affected). Migrate at your own pace — we'll remove the legacy alias in v6, not before 2027-Q1.

## Why the rename

v4 shipped as "@delegance/guardrail — LLM code review." The real product is an end-to-end autonomous development pipeline (brainstorm → spec → plan → implement → migrate → validate → PR → review → merge). Guardrail is now one phase (the review phase) of that pipeline. The rename makes the product and package identity match.

## What works without any changes

Every v4 invocation continues to work in v5.x:

- `npx guardrail run` ✓
- `npx guardrail run --base main --diff` ✓
- `npx guardrail scan src/auth/` ✓
- `npx guardrail ci` ✓
- `npx guardrail setup` ✓
- `npx guardrail doctor` ✓
- `npx guardrail fix --dry-run` ✓
- `npx guardrail baseline create` ✓
- `npx guardrail explain <id>` ✓
- Top 20 v4 subcommand invocations are preserved (intended compatibility). A formal golden-test matrix lands in alpha.2 — if you hit a regression, please open an issue (see bottom).

Your `guardrail.config.yaml` also loads without changes. New config keys (`pipeline`, etc.) are additive.

## What to update when you're ready

### 1. Package name

**`package.json`:**

```diff
{
  "devDependencies": {
-   "@delegance/guardrail": "^4.3.1"
+   "@delegance/claude-autopilot": "^5.0.0"
  }
}
```

Run `npm install` / `pnpm install` / `yarn install` afterwards.

### 2. Shell scripts, pre-commit hooks, Makefiles

Replace the CLI invocation:

```diff
- npx guardrail run --base main
+ npx claude-autopilot run --base main

- npx guardrail scan src/auth/
+ npx claude-autopilot scan src/auth/

- npx guardrail ci
+ npx claude-autopilot ci
```

Or keep using `guardrail run` — it continues to work through v5.x.

### 3. GitHub Actions

```diff
- uses: actions/setup-node@v6
  with:
    node-version: '22'
- run: npm install -g @delegance/guardrail
+ run: npm install -g @delegance/claude-autopilot
- run: guardrail run --base main --format sarif --output results.sarif
+ run: claude-autopilot run --base main --format sarif --output results.sarif
```

### 4. Dockerfiles

```diff
- RUN npm install -g @delegance/guardrail@^4
+ RUN npm install -g @delegance/claude-autopilot@^5
```

### 5. Claude Code skills

The legacy `skills/guardrail.md` is preserved for back-compat. For new setups, use:

```bash
mkdir -p .claude/skills
cp node_modules/@delegance/claude-autopilot/skills/claude-autopilot.md .claude/skills/
```

This new skill drives the full pipeline (not just review). You can also keep `skills/guardrail.md` in place — it now documents itself as the review-phase alias.

## New in v5.0.0-alpha.1

- **`claude-autopilot` CLI binary** — primary entrypoint, co-installed with `guardrail`.
- **Pipeline skills in the tarball** — `skills/claude-autopilot.md`, `skills/autopilot/`, `skills/migrate/` now ship with the package (v4 only shipped `skills/guardrail.md`).
- **`generic` preset** — no-op `migrate`, uses `npm test` / `npm run typecheck` / `npm run lint` for validate. Picked as fallback instead of `nextjs-supabase` when no stack signals are found (fixes the v4.x bug where plain Next.js apps were mislabeled "Next.js + Supabase").
- **Pipeline config flags** — `pipeline.runReviewOnStaticFail` and `pipeline.runReviewOnTestFail` (added in 4.3.1, documented for v5 consumption).

## Rollback

Pin `@delegance/guardrail@^4.3.1` to stay on v4. The package stays on npm; the tombstone release lands with v5.0.0 GA (alpha.1 does not retire v4).

```json
{
  "devDependencies": {
    "@delegance/guardrail": "^4.3.1"
  }
}
```

## Planned removals in v6

- `guardrail` CLI binary (2027-Q1 or later).
- `skills/guardrail.md` alias.
- Legacy top-level subcommand aliases (`guardrail run` → must be `claude-autopilot run`).

We'll announce the v6 cutover at least 3 months ahead of time in the CHANGELOG and on any issues using the `legacy-removal` label.

## Questions or breakage

If something you relied on in v4.x doesn't work in v5.x, that's a regression we want to fix — not something you should silently work around. Open an issue at https://github.com/axledbetter/claude-autopilot/issues with:

1. Your exact v4 invocation
2. The v5 output and error (if any)
3. Which phase of the migration you were following

We treat v5.x compatibility bugs as blockers, not feature requests.
