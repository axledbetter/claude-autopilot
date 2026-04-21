# Contributing

## Setup

```bash
git clone https://github.com/axledbetter/claude-autopilot.git
cd claude-autopilot
npm install
```

**Prerequisites:** Node 22+, tsx (installed via npm install).

## Running Tests

```bash
node scripts/test-runner.mjs       # full suite (136 tests)
npx tsc --noEmit                   # typecheck
```

Tests use Node's built-in `node:test` runner — no Jest, no config.

## Project Layout

```
src/
  cli/          # CLI commands (index.ts, run.ts, setup.ts, preflight.ts, hook.ts, watch.ts)
  core/         # Pipeline engine (config, findings, git, pipeline, chunking, cache)
  adapters/     # Pluggable adapters (review-engine, vcs-host, migration-runner, review-bot)
  formatters/   # SARIF + GitHub Actions annotation output
  snapshots/    # Autoregress snapshot system (serializer, import-scanner, impact-selector)
  index.ts      # Public API exports
bin/
  autopilot.js  # Thin launcher — resolves tsx and spawns src/cli/index.ts
presets/        # Per-stack autopilot.config.yaml defaults (nextjs-supabase, t3, go, etc.)
skills/
  autopilot.md  # Claude Code skill shipped with the package
tests/          # Unit + integration tests (mirrors src/ layout)
```

## Making Changes

1. Branch off `master`
2. Write tests first
3. Run `node scripts/test-runner.mjs` — must stay green
4. Run `npx tsc --noEmit` — no new type errors
5. Open a PR — CI (test + typecheck) must pass before merge

## Cutting a Release

1. Update `CHANGELOG.md` with what changed
2. Bump version in `package.json`
3. Commit: `git commit -m "chore: bump to X.Y.Z"`
4. Tag: `git tag vX.Y.Z`
5. Push: `git push origin master --tags`

CI picks up the `v*` tag, runs tests, validates the tag matches `package.json`, and publishes to npm automatically. If the version is already published (e.g. you published manually), it skips silently.

**Do not run `npm publish` manually** — the CI workflow handles it.

## Adding a Preset

1. Create `presets/<name>/autopilot.config.yaml` with stack-appropriate defaults
2. Add the preset name and label to `src/cli/detector.ts` (`PRESET_LABELS`) and `src/cli/setup.ts`
3. Add detection logic to `detectProject()` in `src/cli/detector.ts`
4. Add a test case in `tests/detector.test.ts`

## Adding a Static Rule

1. Add rule logic to `src/core/static-rules/` (or extend an existing rule file)
2. Register the rule ID in `src/core/config/types.ts`
3. Add test coverage in `tests/static-rules-phase.test.ts`

## Adapter Development

The four pluggable adapter points are `review-engine`, `vcs-host`, `migration-runner`, and `review-bot-parser`. Each has a `types.ts` interface in `src/adapters/<name>/`. To add a new adapter:

1. Create `src/adapters/<name>/<adapter-id>.ts` implementing the interface
2. Register it in `src/adapters/loader.ts`
3. Add tests
