# Contributing

Thanks for taking a look. claude-autopilot is a small project trying to do an ambitious thing — turn a rough idea into a merged PR with no human in the middle. Contributions that make that loop tighter, faster, or more honest are welcome.

## Setup

```bash
git clone https://github.com/axledbetter/claude-autopilot.git
cd claude-autopilot
npm install
```

**Prerequisites:** Node 22+, `tsx` (installed via `npm install`).

The four LLM SDKs (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`, `@modelcontextprotocol/sdk`) are `optionalDependencies` — `npm install` pulls them by default. For a minimal setup with just one provider, use `npm install --omit=optional` then `npm install <sdk-of-choice>`.

## Running tests

```bash
npm test            # full suite — currently 922/922 green
npm run typecheck   # tsc --noEmit, must stay clean
npm run build       # writes to dist/
```

Tests use Node's built-in `node:test` runner — no Jest, no config.

## How the pipeline builds itself

Many features in this repo were implemented by autopilot running against autopilot — see [DEMO.md](DEMO.md) for six self-eat PRs (Phases 1–4 of the v5.4 Vercel adapter, $10 → ~$2.50 cost trajectory). If you have an `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, you can dispatch your own contribution this way:

```bash
claude-autopilot brainstorm "<your idea>"
# ... approve spec, plan ...
claude-autopilot autopilot
```

You're not required to. A normal "edit + test + PR" workflow is equally welcome.

## What kinds of changes we want

**Yes, please:**

- Bug fixes with regression tests (every PR adds at least one test that pins the fix)
- New detector rules (`src/core/migrate/detector-rules.ts`) for migration toolchains we don't recognize yet
- New LLM adapters in `src/adapters/review-engine/` (Bedrock, Mistral, local models via OpenAI-compatible)
- Bigger preset entries under `presets/` for frameworks we don't cover
- Documentation fixes — especially examples that worked end-to-end in your repo

**Probably not:**

- Pivoting the architecture (e.g. adding a hosted control plane). The local-first / BYO-key shape is core to the product
- Replacing Claude Code as the host. claude-autopilot ships as a Claude Code skill set; that's the integration model

If unsure, [open an issue first](https://github.com/axledbetter/claude-autopilot/issues) describing the change. Cheap to discuss before you write code.

## Making changes

1. Branch off `master` (not `main`)
2. Write tests first when fixing a bug — pin the broken behavior before touching the code
3. `npm test` and `npm run typecheck` must stay green
4. Append a one-liner to `CHANGELOG.md` under `## Unreleased`
5. Open a PR — CI runs the same gates plus Cursor Bugbot

## PR conventions

- **Conventional commit titles** — `feat(...)`, `fix(...)`, `docs(...)`, `chore(...)`. The `pr-desc` skill and auto-changelog rely on these.
- **One logical change per PR.** Easier to review, easier to revert.
- **Squash-merge.** Master history is for users; branch history is for you.

## Project layout

```
src/
  adapters/      LLM + deploy + review-bot adapter implementations
  cli/           One file per CLI verb
  core/          Phase logic — config, detection, persistence, validation
skills/          Claude Code skill definitions (SKILL.md + manifest)
presets/         Per-framework presets + JSON schemas
docs/specs/      Feature specs (input to autopilot)
docs/skills/     Skill contracts + version compatibility
tests/           Unit + integration tests (node --test)
```

## Recipes

### Adding a preset

1. Create `presets/<name>/guardrail.config.yaml` and `presets/<name>/stack.md`
2. Register the preset in `src/cli/setup.ts` (`PRESET_LABELS`) and `src/cli/detector.ts`
3. Add detection logic to `detectProject()` in `src/cli/detector.ts`
4. Add a test case in `tests/detector.test.ts`

### Adding a static rule

1. Add rule logic under `src/core/static-rules/`
2. Register the rule ID in `src/core/config/types.ts`
3. Add test coverage in `tests/static-rules-phase.test.ts`

### Adding an adapter

The pluggable adapter points are `review-engine`, `vcs-host`, `migration-runner`, `review-bot-parser`, and `deploy`. Each has a `types.ts` interface in `src/adapters/<name>/`. To add one:

1. Create `src/adapters/<name>/<adapter-id>.ts` implementing the interface
2. Register it in `src/adapters/loader.ts` (or the deploy factory at `src/adapters/deploy/index.ts`)
3. Add tests; for LLM adapters, route the SDK through `src/adapters/sdk-loader.ts` so it stays in `optionalDependencies`

### Adding a migration detector rule

For a new migration tool (some-tool-migrate):

1. Add a rule to `DETECTION_RULES` in `src/core/migrate/detector-rules.ts` with `requireAll` / `requireAny` patterns and a sensible `defaultCommand`
2. Add a fixture-based test in `tests/migrate/detector.test.ts`
3. Update the example list in `skills/migrate/SKILL.md`

## Cutting a release

1. Update `CHANGELOG.md` — move `Unreleased` items into the new version's section
2. Bump version in `package.json`
3. Commit: `git commit -m "chore: bump to X.Y.Z"`
4. Tag: `git tag vX.Y.Z origin/master`
5. Push: `git push origin master --tags`

CI picks up the `v*` tag, runs the gates, and publishes to npm automatically. **Do not run `npm publish` manually.** The workflow validates that the tag matches `package.json` and skips silently if the version is already published.

## What gets reviewed

Every PR runs through:

1. **CI** — `npm test`, `npm run typecheck`, build
2. **Cursor Bugbot** — automated review on PR. Findings are triaged via `scripts/bugbot.ts`; same loop autopilot uses on user PRs
3. **Codex** for design-level feedback when relevant — `npx tsx scripts/codex-review.ts <file>`
4. **Maintainer** — at least one human reviews before merge

Most PRs land within a few days. Bug fixes with regression tests are usually faster.

## Filing issues

Bug reports — please include:

- Output of `claude-autopilot doctor`
- The exact command + full stderr
- `cat .guardrail-cache/cost-log.ndjson | tail -5` if cost/usage is involved

Feature requests — describe the use case, not just the feature. "I want X" is harder to evaluate than "I'm trying to Y but the current path doesn't fit because Z."

## Code of conduct

Be kind. Disagree about ideas, not people. We're all trying to make autonomous coding work; that's hard enough without anyone being a jerk about it.

## Questions

[Open an issue.](https://github.com/axledbetter/claude-autopilot/issues) Faster than email.
