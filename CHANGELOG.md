# Changelog

## [1.6.0] — 2026-04-22

### Added
- **Provider usage scanner** (`src/core/detect/provider-usage.ts`) — walks project source files, counts per-provider API key and SDK references (capped at 1 per file to avoid skew), returns `ProviderCounts`
- **`dominantProvider()`** — returns the provider with the highest file-reference count
- **Smart `auto` tiebreaker** — when multiple API keys are present, `auto` scans the codebase and prefers the provider already used there; falls back to env-key priority order if counts are all zero
- `ReviewInput.context.cwd` — threads working directory through to the review engine so `auto` knows where to scan; `review-phase.ts` now passes `cwd` in context
- 12 new tests for `detectProviderUsage` and `dominantProvider` — **181 total**

## [1.5.0] — 2026-04-22

### Added
- **Gemini adapter** (`gemini`) — Google Gemini 2.5 Pro via `@google/generative-ai`; accepts `GEMINI_API_KEY` or `GOOGLE_API_KEY`; 1M token context window
- **OpenAI-compatible adapter** (`openai-compatible`) — works with any OpenAI-API-compatible endpoint (Groq, Ollama, Together AI, etc.); requires `options.model`; auto-selects API key via `options.apiKeyEnv` → `OPENAI_API_KEY` → `'ollama'`
- **Updated auto adapter** — full priority chain: `ANTHROPIC_API_KEY` → `GEMINI_API_KEY`/`GOOGLE_API_KEY` → `OPENAI_API_KEY` → `GROQ_API_KEY` (wraps openai-compatible with Groq config)
- `run.ts` no-key warning now lists all four key options

### Changed
- 169 tests total (up from 136)

## [1.4.0] — 2026-04-21

### Added
- **Static rules registry** (`src/core/static-rules/registry.ts`) — lazy-loads built-in rules by name; fixes critical bug where config `staticRules` was always silently ignored
- **7 built-in rules**: `hardcoded-secrets`, `npm-audit`, `package-lock-sync`, `console-log`, `todo-fixme`, `large-file`, `missing-tests`
- **Claude adapter** (`claude`) — Anthropic Claude Opus 4.7 via `@anthropic-ai/sdk`; configurable model via `context.model`
- **Auto adapter** (`auto`) — detects best available key at runtime; checked in priority order
- `doctor` now checks `ANTHROPIC_API_KEY` in addition to `OPENAI_API_KEY`
- 136 tests total

### Fixed
- **Critical**: `staticRules` in `RunInput` was never populated — config-listed rules were silently ignored. `loadRulesFromConfig()` now wired into `run.ts`

## [1.2.8] — 2026-04-21

### Added
- 8 new tests covering npm placeholder detection, pyproject.toml FastAPI detection, `resolveGitTouchedFiles` ignore list, deduplication, and status fallback — **136 total**

## [1.2.7] — 2026-04-21

### Fixed
- `autopilot run` now loads `.env.local` / `.env` at startup so `OPENAI_API_KEY` (and other env vars) are available without exporting them in the shell first

## [1.2.6] — 2026-04-21

### Added
- `skills/autopilot.md` included in npm package — install once, then `cp node_modules/@delegance/claude-autopilot/skills/autopilot.md .claude/skills/` to give Claude Code full context on when and how to invoke the CLI

## [1.2.5] — 2026-04-21

### Added
- `--version` / `-v` flag — prints package version and exits
- Built-in ignore list for git diff output: `node_modules/`, `dist/`, `build/`, `.next/`, `.nuxt/`, `out/`, `coverage/`, `.turbo/`, `.cache/`, `vendor/`, `__pycache__/`, `.venv/`, `venv/`, `target/`, `.gradle/` — prevents build artifact floods from polluting the changed-files list

## [1.2.4] — 2026-04-21

### Changed
- `autopilot init` is now deprecated — prints a notice and delegates to `autopilot setup`

### Fixed
- Removed superpowers plugin check from `doctor` — it was warning all external developers about a Delegance-internal tool they cannot install

## [1.2.3] — 2026-04-21

### Fixed
- README rewrite: `setup` and `doctor` commands now prominent; config schema accurate; public API section added

## [1.2.2] — 2026-04-21

### Fixed
- Hook install called from `setup` no longer double-prints stderr; added `silent` option to `runHook()` to suppress output when invoked programmatically

## [1.2.1] — 2026-04-21

### Fixed
- `bin/autopilot.js` tsx resolution now checks the consumer's `node_modules/.bin/tsx` before falling back to PATH — fixes "tsx not found" on fresh installs
- npm default test placeholder (`echo "Error: no test specified" && exit 1`) is now detected and replaced with `npm test` instead of being used as the test command

## [1.2.0] — 2026-04-21

### Added
- `autopilot doctor` — prerequisite checker: verifies Node 22+, tsx, gh CLI auth, claude CLI, OPENAI_API_KEY, git config, superpowers plugin; shows exact fix command for each failure; exits 1 if any blockers
- `autopilot setup` now runs `doctor` automatically at the end so users immediately see what still needs attention
- `autopilot preflight` kept as alias for `doctor`

## [1.1.0] — 2026-04-21

### Added
- `autopilot setup` — zero-prompt setup: auto-detects project type (Go, Rails, FastAPI, T3, Next.js+Supabase), infers test command, writes config, installs git hook in one command
- `autopilot setup --force` — overwrite existing config

## [1.0.2] — 2026-04-21

### Fixed
- README: install command updated (`--save-dev` removed, `@alpha` tag removed); hard prerequisites documented
- preflight: tsx missing message no longer suggests `--save-dev` (tsx is now a runtime dependency)

## [1.0.1] — 2026-04-21

### Fixed
- Move `tsx`, `js-yaml`, `ajv`, `dotenv`, `minimatch`, `openai` from `devDependencies` to `dependencies` — CLI was broken for end-users who installed via npm since devDeps aren't installed by consumers

## [1.0.0] — 2026-04-21

### Changed
- Promoted from 1.0.0-rc.1 — no new changes, stable release

## [1.0.0-rc.1] — 2026-04-21

### Added
- `autopilot init` now shows full next-steps: hook install, autoregress generate, CI snippet, first run
- Public API surface: `Finding`, `RunResult`, `AutopilotConfig`, `normalizeSnapshot` exported from package root via `exports` field in package.json

### Changed
- Version promoted from 1.0.0-alpha.8 → 1.0.0-rc.1

## 1.0.0-alpha.8

### Added

- **`autopilot autoregress`** — `autoregress run|diff|update|generate` now a first-class `autopilot` subcommand (no more raw `npx tsx scripts/autoregress.ts`)
- **GitHub Actions CI** — `.github/workflows/ci.yml` runs typecheck + tests on every PR; auto-publishes to npm on `v*` tags
- **README rewrite** — full feature documentation covering all alphas (all commands, config, GitHub Actions, snapshot regression, architecture)

## 1.0.0-alpha.7

### Added

- **`autopilot hook install`** — writes a `pre-push` git hook that runs `autoregress run` before every push; `hook uninstall` removes it; `hook status` shows current state; `--force` overwrites existing hook
- **`autoregress diff`** — colored snapshot viewer showing line-by-line JSON diffs between current output and baselines; exits 1 if any diffs found (never modifies baselines — use `update` for that)
- **`autoregress generate --files <list>`** — explicit comma-separated file list bypasses git detection; generates baselines for any src file on demand
- **Real baselines** — `tests/snapshots/*.snap.ts` + baselines for `serializer.ts`, `import-scanner.ts`, `impact-selector.ts`, and `sarif.ts` — alpha.6 infrastructure now self-testing via snapshots

## 1.0.0-alpha.6

### Added

- **Auto-regression testing** (`scripts/autoregress.ts generate|run|update`) — autoresearch-inspired snapshot tests for changed source modules
- **Impact-aware selection** — only fires snapshots whose source modules (or one-hop importers) were touched; high-impact paths (`src/core/pipeline/**`, `src/adapters/**`, `src/core/findings/**`, `src/core/config/**`) and >10-file changes trigger full run
- **Snapshot serializer** (`src/snapshots/serializer.ts`) — deterministic JSON normalization: sorted keys, `<timestamp>`, `<uuid>`, path stripping
- **Import scanner** (`src/snapshots/import-scanner.ts`) — static `import`/`export` graph → reverse dependency map
- **Impact selector** (`src/snapshots/impact-selector.ts`) — merge-base diff + one-hop expansion + overrides
- **Baseline capture** — `CAPTURE_BASELINE=1` env flag; `autoregress update` rewrites baselines after intentional changes
- **Staleness detection** — warns and skips snapshots whose `@snapshot-for` source file no longer exists
- 10 new unit tests (AR1-AR10) for serializer, import scanner, and impact selector

## 1.0.0-alpha.5 (2026-04-21)

### New Features

- **`--format sarif --output <path>`** on `autopilot run` — serialises `RunResult` to SARIF 2.1.0; deduplicates rules by category; normalises URIs to repo-relative forward-slash; always emits `results: []` even on error so `upload-sarif` never fails on a missing file
- **Auto GitHub Actions annotations** — when `GITHUB_ACTIONS=true`, `emitAnnotations()` fires after every run and writes `::error`/`::warning`/`::notice` workflow commands to stdout; GitHub renders these as inline annotations on the PR diff
- **`src/formatters/`** — pure formatter modules (`sarif.ts`, `github-annotations.ts`) with full command-injection encoding (`%`, `\r`, `\n`, `:`, `,`) for annotation properties and data
- **`action.yml`** composite action — checkout → setup-node@v4 → npx autopilot run → upload-sarif@v3; inputs: `version`, `config`, `sarif-output`, `openai-api-key`; upload step runs `if: always()` so findings surface even when run exits 1
- 21 new formatter tests (11 SARIF + 10 annotations) → **95 total**

## 1.0.0-alpha.4 (2026-04-21)

### New Features

- **`autopilot watch`** (`src/cli/watch.ts`) — watches cwd recursively, debounces file changes (default 300ms), re-runs `runAutopilot()` on each batch, prints phase summary per run; Ctrl+C exits cleanly
- **`--debounce <ms>`** flag on `watch` subcommand
- **`makeDebouncer`** and **`isIgnored`** exported as pure functions (testable without real watcher)
- **`files` field** in package.json — excludes tests, restricts publish to `bin/`, `src/`, `presets/`, `scripts/test-runner.mjs`, `CHANGELOG.md`
- **`private: true` removed** — package is now publishable to npm
- **`engines.node: >=22.0.0`**, `keywords`, `license`, `repository` added to package.json
- 12 new watch tests (7 isIgnored + 5 debouncer) → 74 total

## 1.0.0-alpha.3 (2026-04-21)

### New Features

- **`autopilot run`** (`src/cli/run.ts`) — runs the full pipeline from the terminal: loads config, resolves preset, auto-detects changed files via git diff, calls `runAutopilot()`, prints phase summary with inline finding details
- **`autopilot init`** (`src/cli/init.ts`) — interactive preset scaffold: lists 5 presets, writes `autopilot.config.yaml`, prints next steps
- **`autopilot preflight`** — re-routes to existing preflight checker
- **Git touched-files resolver** (`src/core/git/touched-files.ts`) — `resolveGitTouchedFiles()` diffs HEAD~1..HEAD, falls back to `git status` for single-commit repos; configurable `--base` ref
- **CLI entrypoint** (`src/cli/index.ts`) — dispatches to init/run/preflight subcommands; supports `--base`, `--config`, `--files`, `--dry-run` flags
- **`bin.autopilot`** restored in `package.json` pointing at the new entrypoint
- 10 new CLI tests (5 touched-files, 5 run-command) → 62 total

## 1.0.0-alpha.2 (2026-04-20)

### New Features

- **Run pipeline orchestrator** (`src/core/pipeline/run.ts`) — top-level `runAutopilot()` sequences static-rules → tests → review phases with fail-fast semantics and cost accumulation
- **2-tier chunking** (`src/core/chunking/`) — `auto` strategy selects single-pass (≤8K tokens) or file-level (≤60K); `single-pass` and `file-level` strategies configurable via `reviewStrategy`
- **Cost visibility** — `costUSD` accumulated across review phase, surfaced in `RunResult.totalCostUSD`; optional `cost.budgetUSD` threshold emits warning and skips remaining chunks when exceeded
- **Review-engine response cache** (`src/core/cache/`) — file-based SHA-256 cache with configurable TTL; `withCache()` wraps any `ReviewEngine`; atomic writes (tmp+rename)
- **4 new presets** — `t3` (Next.js + tRPC + Prisma), `rails-postgres`, `python-fastapi`, `go`; each ships a stack.md and at least one stack-specific static rule
- **20 scenario tests** (`tests/scenarios/run-pipeline.test.ts`) — covers fail-fast, autofix, budget, chunking strategies, preset loading

### Fixes

- `finalize()` now trusts per-phase status (which accounts for autofixes) instead of re-deriving from raw `allFindings` severity
- Test script glob changed to `find tests -name '*.test.ts' | xargs` to pick up nested scenario tests

## 1.0.0-alpha.1 (2026-04-20)

Initial release — core infrastructure: adapter interfaces, config system, preflight CLI, static-rules phase with autofix, tests phase, Codex/GitHub/Supabase/Cursor adapters, nextjs-supabase preset, 32 unit tests.
