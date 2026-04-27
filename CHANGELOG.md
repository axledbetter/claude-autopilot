# Changelog

## [5.0.0-alpha.5] — 2026-04-27

Second hotfix from the soak. Alpha.4 fixed `init`'s preset resolution but `scan` / `run` still crashed on compiled output with `Failed to import adapter from .../auto.ts` — the adapter loader and static-rule registry use dynamic-import string literals that tsc's `rewriteRelativeImportExtensions` doesn't touch.

### Fixed
- **`scan` / `run` adapter loading under compiled JS.** `src/adapters/loader.ts` BUILTIN_PATHS and `src/core/static-rules/registry.ts` import map both used hardcoded `.ts` extensions in dynamic-import string literals. TS's emit-time rewriter only handles static imports, so these strings stayed `.ts` post-compile and the runtime tried to load `dist/.../auto.ts` (which doesn't exist; the file is `auto.js`). New helper `resolveSiblingModule()` in `src/cli/_pkg-root.ts` swaps `.ts` → `.js` based on whether the caller is itself compiled.

### Added
- **Real-world soak benchmark result.** Against a 13-bug seeded Next.js fixture (SQL injection, hardcoded secret, missing auth, IDOR, CORS wildcard, SSRF, open redirect, TOCTOU, silent error swallow, off-by-one, missing rate limit, console.log, no input validation), `claude-autopilot scan --all` with the `claude` adapter caught **13 of 13** with concrete remediation. The cold-start eval reviewer's original run with Llama 3.3 70B caught 8/13 (and even that was blocked by the parser bug now fixed).
- 4 new tests in `tests/pkg-root.test.ts` covering `resolveSiblingModule` semantics across source/.js/.mjs callers, plus a regression test that compiles `dist/` and imports the registry to verify dynamic-import refs resolve.

## [5.0.0-alpha.4] — 2026-04-27

Hotfix discovered by post-publish soak. The previous alpha.3 published a compiled `dist/` bundle but the path-resolution sites that look up `presets/`, `package.json`, etc. assumed source-tree layout (`../..` from `src/cli/<file>.ts` = package root). Under the compiled layout (`dist/src/cli/<file>.js`), the same `../..` resolves to `dist/`, which doesn't contain `presets/` or `package.json`. Result: `npx @delegance/claude-autopilot@alpha init` crashed with "Preset config not found for: generic" — a release-blocker missed by every prior CI check.

### Fixed
- **`init` / `setup` no longer crash on compiled output.** All sites that previously did `path.resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')` now use `findPackageRoot()` from a new shared helper at `src/cli/_pkg-root.ts`. The helper walks up from `import.meta.url` looking for the `@delegance/claude-autopilot` `package.json`, so it lands on the same package root whether the caller is source or compiled.
- Affected sites: `src/cli/setup.ts`, `src/cli/init.ts`, `src/cli/run.ts` (`readToolVersion`), `src/cli/pr-comment.ts` (`readVersion`).

### Added
- `src/cli/_pkg-root.ts` — `findPackageRoot()` and `requirePackageRoot()`.
- `tests/pkg-root.test.ts` — unit test for the helper, plus a full integration smoke that builds `dist/`, invokes `node dist/src/cli/index.js init --preset generic` against a fresh temp project, and asserts `guardrail.config.yaml` is written. Catches future compiled-vs-source path drift.

### Notes for users on alpha.3
- If you ran `npx @delegance/claude-autopilot@alpha init` on alpha.3 and saw "Preset config not found", upgrade with `npm install -g @delegance/claude-autopilot@alpha` to pick up alpha.4. No config changes needed.

## [5.0.0-alpha.3] — 2026-04-24

Final alpha before v5.0.0 GA. Closes every remaining GA blocker from the alpha cycle.

### Added
- **Compiled JS entrypoint** — `npm run build` emits `dist/src/**/*.js` via `tsc -p tsconfig.build.json`. The launcher at `bin/_launcher.js` prefers the compiled output when present (global installs), falls back to `src/` + `tsx` for dev workflows. Drops `tsx` from the runtime hot path for published installs. Uses TypeScript 6's `rewriteRelativeImportExtensions: true` to rewrite `.ts` → `.js` specifiers at emit time; includes a defensive post-build rewriter script that no-ops when tsc already did the work.
- **`claude-autopilot migrate-v4` codemod** — `src/cli/migrate-v4.ts`. Scans a target repo for `@delegance/guardrail` and `guardrail <verb>` references, proposes replacements, applies with `--write` (creates `.v4-backup.<timestamp>` files and writes a restore manifest). `--undo` reads the manifest and restores by sha256 match — refuses to overwrite files modified after the migrate. Covers `package.json` (dependency sections with operator preservation), shell scripts, Makefiles, GitHub Actions yaml, Dockerfiles (including CMD-array `["guardrail", "verb"]` form). Skips `node_modules/`, `dist/`, and the tool's own `.claude-autopilot/` state dir.
- **Tombstone `@delegance/guardrail@5.0.0`** package at `packages/guardrail-tombstone/`. Thin CLI wrapper that forwards argv / stdio / exit code / signal to `@delegance/claude-autopilot`. Resolves the child via `createRequire().resolve()` (works under npm / pnpm / yarn / PnP) with two relative-probe fallbacks and a last-resort PATH lookup. Emits a one-line deprecation notice on stderr (silenceable via `CLAUDE_AUTOPILOT_DEPRECATION=never`). Maps ENOENT to exit 127 with an actionable install hint.
- **CI bin-parity workflow** at `.github/workflows/bin-parity.yml`. On every push to master + PR, runs matrix (ubuntu + macos × node 22 + 24) that packs a tarball, globally installs, then asserts: (a) both bins return semver, (b) deprecation notice is on stderr under `always`, (c) deprecation does not leak onto stdout, (d) exit codes match between `claude-autopilot` and `guardrail` on a non-zero-exit invocation. A second job installs from the published `@alpha` tag on push to master for real-world parity.
- **Prefix-hygiene test** at `tests/no-legacy-prefix.test.ts` — asserts that `src/cli/**` uses `[claude-autopilot]` not `[guardrail]`, with an explicit allowlist for legitimate legacy references (bin wrappers, launcher).
- `tsconfig.build.json` — separate build config with `rewriteRelativeImportExtensions: true` and explicit emit settings.
- `scripts/post-build-rewrite-imports.mjs` — defensive rewriter for `.ts` → `.js` import specifiers in emitted JS. No-op when tsc emits correctly.
- `prepublishOnly` script — runs `build && test` before any `npm publish`.
- 14 new tests (migrate-v4: 7, tombstone-bin: 3, no-legacy-prefix: 1, others: 3).

### Changed
- **Error prefixes normalized** — every `[guardrail] ...` error message in `src/cli/index.ts` and `src/cli/preflight.ts` now uses `[claude-autopilot]` or the phase name (`[run]`, `[doctor]`). Legacy `[guardrail]` retained only in the bin-wrapper deprecation notice, `bin/_launcher.js`, and the tombstone package (where it legitimately refers to the deprecated package name).
- **Welcome screen rewritten** — bare `claude-autopilot` invocation now leads with the pipeline pitch (`claude-autopilot brainstorm "..."`) and frames the review subcommands as the v4-compatible alternative. Previously sold the package as "LLM code review."
- **Version resolution in `src/cli/index.ts`** — walks up from `import.meta.url` for the nearest `@delegance/claude-autopilot` `package.json` instead of a hardcoded `../../package.json`. Necessary because the compiled entrypoint lives at `dist/src/cli/index.js` where the old relative path resolved to `dist/package.json` (which doesn't exist).
- **`package.json` `files` field** now includes `dist/` (new) and `scripts/post-build-rewrite-imports.mjs`.
- `preflight.ts`: "Guardrail prerequisite check" heading → "claude-autopilot prerequisite check".

### Fixed
- (None — alpha.3 is feature work; no regressions surfaced by the compat matrix.)

### Still manual for GA
- Alex to publish `@delegance/guardrail@5.0.0` tombstone from `packages/guardrail-tombstone/`.
- Alex to run `npm dist-tag add @delegance/claude-autopilot@5.0.0 latest` once 5.0.0 GA ships.
- Alex to run `npm deprecate @delegance/claude-autopilot@"<5.0.0" "Use @delegance/claude-autopilot@alpha during alpha cycle, or @latest after GA"` to flag pre-rename versions.

## [5.0.0-alpha.2] — 2026-04-24

### Added
- **v4 compatibility assertion matrix** at `tests/v4-compat/` — 20 pinned invocations covering version/help, subcommand routing for all v4 names, deterministic reads (doctor, costs, baseline, explain), flag parsing (`--base`, `--format`, `--fail-on`), deprecation-notice behavior, and the new grouped verbs. Uses marker/regex assertions, not full stdout snapshots — still catches routing and parsing regressions, which is the intent. Full normalized-stdout snapshots for deterministic commands are a follow-up item. Regression of any test blocks future alpha promotion.
- **Superpowers peer-dep detection** — `doctor` now reports a warn-level check for `superpowers:writing-plans`, `superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`. Missing skills produce an actionable remediation hint (`claude plugin install superpowers`). Treated as warn not fail because review-only users don't need it; pipeline phases will hard-fail at their own entry point.
- **Grouped CLI verbs (phase 1: additive aliases)** — `claude-autopilot review <verb>` accepts `{run, scan, ci, fix, baseline, explain, watch, report}`. `claude-autopilot advanced <verb>` accepts `{lsp, mcp, worker, autoregress, test-gen, hook, detector, ignore}`. Both are additive aliases — flat forms (`claude-autopilot run`) continue to work unchanged. Broader restructuring (pipeline verbs `migrate`/`validate` top-level, `pr {create,comment,desc}`) is a later-alpha item.
- **`peerDependencies.superpowers`** (optional) declared in `package.json`.
- `src/cli/preflight.ts`: `findMissingSuperpowersSkills()` exported with recursive search across `~/.claude/plugins/**` and project-local `.claude/plugins/**`.

### Fixed
- **`--help` / `-h` routed to `run`** (latent v4 bug). v4's dispatcher defaulted the subcommand to `run` when `args[0]` started with `--`, so `guardrail --help` silently executed a review instead of printing help. v5.0.0-alpha.2 intercepts `--help`/`-h` before subcommand defaulting and routes to the help handler. Surfaced by the new v4 compat matrix.
- **`--help` output missing 8 v4 subcommands** — `setup`, `preflight`, `hook`, `baseline`, `triage`, `pr-desc`, `council`, `mcp` were listed in the `SUBCOMMANDS` array but not in `printUsage()`. Help now lists all 20+.

### Changed
- README install instructions now pin `@alpha` explicitly for the v5 alpha cycle. The npm `latest` tag still points at a pre-rename 2.5.0 release; without pinning, bare installs silently regress to old code. When 5.0.0 GA ships, `latest` advances and the `@alpha` pin becomes optional.
- Migration guide updated with the `@alpha` pinning note for `npm install`, GitHub Actions, and Dockerfile examples.

### Still deferred to alpha.3
- Tombstone `@delegance/guardrail@5.0.0` with thin CLI wrapper and strict argv/stdio passthrough.
- CI bin-parity smoke tests (`npx guardrail`, `npx @delegance/guardrail`, global install, GitHub Actions).
- Codemod script `claude-autopilot migrate-v4 [--write]`.
- Compiled JS entrypoint (drops `tsx` runtime dep).

## [5.0.0-alpha.1] — 2026-04-24

**Package renamed: `@delegance/guardrail` → `@delegance/claude-autopilot`.**

The v4 product sold itself as "LLM code review." The real product is an end-to-end autonomous development pipeline built on Claude Code skills — brainstorm → spec → plan → implement → migrate → validate → PR → review → merge. This alpha corrects the identity mismatch without breaking any v4 usage.

Every v4 invocation continues to work through v5.x via the preserved `guardrail` CLI alias. Migration guide: `docs/migration/v4-to-v5.md`.

### Added
- **`claude-autopilot` CLI binary** — primary entrypoint (`bin/claude-autopilot.js`), co-installed with `guardrail`.
- **Pipeline skills bundled in the tarball** — `skills/claude-autopilot.md` (agent-loop spec), `skills/autopilot/`, `skills/migrate/`. v4.3.1 shipped only `skills/guardrail.md`; the pipeline skills existed only in-repo and weren't distributed.
- **`generic` preset** — no DB migration runner, uses `npm test` / `npm run typecheck` / `npm run lint` where present. Picked by `detectProject()` as the fallback when no stack signals are found (replaces the v4 behavior of claiming `nextjs-supabase` with low confidence).
- **v5 migration guide at `docs/migration/v4-to-v5.md`** — find/replace patterns for `package.json`, shell scripts, GitHub Actions yaml, Dockerfiles, and Claude Code skills.

### Changed
- **Stack detector fallback:** plain Next.js with no Supabase signals now returns `generic`, not `nextjs-supabase (low confidence)`. Fixes the cold-start eval reviewer finding.
- **`PRESET_LABELS` in `setup.ts`:** adds `generic` entry.
- **Detector tests:** updated to assert the new `generic` fallback behavior.
- **`skills/guardrail.md`:** rewritten as a back-compat alias pointing at `skills/claude-autopilot.md`.
- **`bin/guardrail.js`:** emits a one-line deprecation notice on `stderr` on first invocation per terminal session, then forwards unchanged.

### Deferred to later alphas
- **alpha.2:** full CLI verb restructure (`claude-autopilot {review,pr,triage,advanced,…}`), v4 compatibility golden-test matrix, superpowers peer-dep hard-fail in `doctor`.
- **alpha.3:** tombstone `@delegance/guardrail@5.0.0` publish, CI smoke tests for `npx guardrail` / `npx @delegance/guardrail` / global install / GitHub Actions parity, codemod script for find/replace migration.
- **5.0.0 GA:** after alpha.3 soaks against delegance-app for 2+ real feature pipelines.

## [4.3.1] — 2026-04-24

### Fixed (from external cold-start review)
- **`parseReviewOutput` silent failure** — regex required literal `### [CRITICAL]` brackets and returned zero findings when the LLM emitted `### CRITICAL`, `### **CRITICAL**`, or `### **[CRITICAL]**` (all common Llama/GPT variants). `src/adapters/review-engine/parse-output.ts` now accepts all four formats and logs a warning when raw output is non-empty but no findings parse, so format drift never silently hides bugs again.
- **Pipeline short-circuit skipped LLM review** — `src/core/pipeline/run.ts` returned early on static-rules `fail`, meaning the LLM never ran on the code that most needed it (IDOR, TOCTOU, CORS, off-by-one, rate-limit gaps typically ride alongside a static-flagged issue). New default: review runs even on static-fail. Legacy behavior restored via `pipeline.runReviewOnStaticFail: false` in config.
- **`doctor` / `preflight` ignored 3 of 5 LLM keys** — only checked `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, so users with `GROQ_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY` set saw "No LLM API key" right after `setup` reported "detected." New shared helper `src/core/detect/llm-key.ts` is the single source of truth used by setup, scan, run, and preflight.
- **Stack detector mislabeled plain Next.js as "Next.js + Supabase"** — now requires actual Supabase signals (`@supabase/supabase-js`, `@supabase/ssr`, `@supabase/auth-helpers-nextjs`, `supabase/config.toml`, or `SUPABASE_*` env vars). Vanilla Next.js still uses the `nextjs-supabase` preset as a fallback but the evidence string and setup output make the fallback explicit.
- **`--profile team` missing security rules** — added `package-lock-sync`, `ssrf`, `insecure-redirect` to match the README's advertised coverage.

### Added
- `src/core/detect/llm-key.ts` — `detectLLMKey()`, `LLM_KEY_NAMES`, `LLM_KEY_HINTS`, `loadEnvFile()`.
- `GuardrailConfig.pipeline.runReviewOnStaticFail` / `runReviewOnTestFail` config flags.
- 6 parser format-variation tests covering all documented markdown variants plus the silent-drift warning path.

## [2.5.0] — 2026-04-22

### Added
- **Config schema validation** — `ignore:` and `reviewStrategy: diff|auto-diff` now accepted; unknown keys reported as `unexpected key "<name>"`; enum errors list allowed values; error message includes up to 5 violations with field paths
- **`autopilot fix`** — reads `.autopilot-cache/findings.json`, asks the configured LLM to rewrite the ±20 lines around each finding, applies patches in place; `--severity critical|warning|all` (default: critical); `--dry-run` previews without writing; exits 1 if any fix fails
- **`autopilot costs`** — prints all-time run count + spend, 7-day summary, and a last-10-runs table (date, files, tokens in/out, cost, duration)
- `src/cli/fix.ts` — `runFix()`; sends numbered context window to LLM with fix instructions; strips markdown fences from response; handles `CANNOT_FIX` sentinel gracefully
- `src/cli/costs.ts` — `runCosts()` reading `.autopilot-cache/costs.jsonl`
- 9 new tests — **266 total**

## [2.4.0] — 2026-04-22

### Added
- **`ignore:` config key** — embed suppression rules in `autopilot.config.yaml` via `ignore: ['tests/**', { rule: hardcoded-secrets, path: src/vendor/** }]`; merged with `.autopilot-ignore` file rules at run time
- **Per-run cost log** — appends `{timestamp, files, inputTokens, outputTokens, costUSD, durationMs}` to `.autopilot-cache/costs.jsonl` after every run; corrupt lines skipped on read; `readCostLog()` exported for tooling
- **`--inline-comments`** — posts a GitHub PR review with per-line inline comments for every finding that has a `file:line`; re-runs dismiss the previous autopilot review before posting a new one; `autopilot ci` enables this by default (`--no-inline-comments` to opt out)
- **`reviewStrategy: auto-diff`** — tries diff first, falls back to full-file `auto` when diff is empty (new files, no git history); `--diff` flag still forces pure diff mode
- `src/cli/pr-review-comments.ts` — `postReviewComments()` using `gh api repos/{nwo}/pulls/{pr}/reviews`
- `src/core/persist/cost-log.ts` — `appendCostLog()`, `readCostLog()`
- 9 new tests — **257 total**

## [2.3.0] — 2026-04-22

### Added
- **Parallel chunk review** — file-level chunks are now reviewed concurrently (default parallelism: 3, configurable via `chunking.parallelism`); serial fallback preserved when `cost.budgetUSD` is set so budget enforcement remains accurate
- **`.autopilot-ignore`** — project-level suppression file; format: `<rule-id> <glob>` or bare `<glob>` (matches any finding on that path); comments and blank lines ignored; suppressed count printed dim after run
- **`--delta` mode** — only reports findings new since the previous run; pre-existing findings are hidden and the count is printed dim; findings always persisted to `.autopilot-cache/findings.json` after each run (gitignored)
- `src/core/ignore/index.ts` — `loadIgnoreRules()`, `applyIgnoreRules()`
- `src/core/persist/findings-cache.ts` — `loadCachedFindings()`, `saveCachedFindings()`, `filterNewFindings()`
- 15 new tests — **248 total**

## [2.2.0] — 2026-04-22

### Added
- **`reviewStrategy: diff`** — new chunking strategy that sends `git diff` unified hunks instead of full file contents; typically ~70% fewer tokens and more focused findings (LLM sees exactly what changed)
- **`--diff` flag** on `run` and `ci` subcommands — shorthand to activate diff strategy without editing config
- **`src/core/git/diff-hunks.ts`** — `getFileDiffs()`, `parseUnifiedDiff()`, `formatDiffContent()`; per-file diff sections in fenced code blocks; files that exceed `maxChars` are omitted with a count notice
- `BuildChunksInput.base` / `ReviewPhaseInput.base` / `RunInput.base` — threads git base ref through pipeline to diff engine
- 9 new tests for `parseUnifiedDiff` and `formatDiffContent` — **233 total**

## [2.1.0] — 2026-04-22

### Added
- **Risk-weighted file ordering** (`src/core/chunking/risk-ranker.ts`) — ranks files before sending to LLM: protected paths (score 100) → auth/security (80) → payment/billing (70) → core logic (50) → config files (40) → everything else (30) → tests (10) → docs (5); ensures most sensitive code appears at the start of the LLM's context window
- `BuildChunksInput.protectedPaths` — passed from config through review-phase to ranker so glob patterns from `protectedPaths:` config key are respected
- 9 new tests for `rankByRisk` — **224 total**

## [2.0.0] — 2026-04-22

### Added
- **`autopilot ci`** — opinionated single-command CI entrypoint; defaults to `--post-comments`, `--format sarif`, and base ref from `GITHUB_BASE_REF`/`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`/`HEAD~1`; supports `--base`, `--output`, `--no-post-comments`
- **`.github/actions/ci/action.yml`** — composite GitHub Actions action; accepts `anthropic-api-key`, `openai-api-key`, `gemini-api-key`, `groq-api-key`, `base-ref`, `config`, `sarif-output`, `post-comments` inputs; runs `npx autopilot ci`, uploads SARIF via `codeql-action/upload-sarif@v3`
- **Updated `skills/autopilot.md`** — complete rewrite covering all adapters, auto-detection, `--post-comments`, `ci` command, action.yml usage

## [1.9.0] — 2026-04-22

### Added
- **`--post-comments` flag on `run`** — posts a formatted markdown summary to the open PR after the pipeline; edits existing autopilot comment on re-runs instead of creating a new one (tracked via `<!-- autopilot-review -->` marker)
- **`detectPrNumber()`** — reads `PR_NUMBER`/`GH_PR_NUMBER`/`GITHUB_PR_NUMBER` env vars (CI) or falls back to `gh pr view` (local)
- **`formatComment()`** — status badge, context line, phase table, critical/warning findings with `file:line`, notes in `<details>`, cost footer
- 10 new formatter tests — **215 total**

## [1.8.0] — 2026-04-22

### Added
- **Shared `parseReviewOutput()`** (`src/adapters/review-engine/parse-output.ts`) — extracts `file:line` attribution from review finding bodies; used by all five adapters; eliminates ~100 lines of duplicated parser code

### Fixed
- `hardcoded-secrets` false positive on route object keys containing `password` (e.g. `forgot_password: '/forgot-password'`)

## [1.7.2] — 2026-04-22

### Fixed
- `hardcoded-secrets` rule no longer fires on route path values (values starting with `/`)

## [1.7.1] — 2026-04-22

### Added
- Detection logging: `auto-detected:` line in run output shows stack, protected paths, and test command when inferred; git context (branch + last commit) shown on every run

## [1.7.0] — 2026-04-22

### Added
- **Stack auto-detection** (`src/core/detect/stack.ts`) — infers human-readable stack string from `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, `Gemfile`; detects framework, ORM, auth, UI library, language; injected into review prompt automatically when `stack:` is absent from config
- **Protected-paths auto-detection** (`src/core/detect/protected-paths.ts`) — scans for migration dirs (`data/deltas/`, `migrations/`, `db/migrate/`, `prisma/migrations/`, `alembic/versions/`, `flyway/`), schema files (`schema.prisma`, `schema.sql`, `db/schema.rb`), infra dirs (`terraform/`, `k8s/`, `helm/`, `.github/workflows/`); populates `protectedPaths` when not set in config
- **Test-command runtime fallback** — re-runs project detector at `run` time when `testCommand` is absent from config; `null` still disables the test phase explicitly
- **Git context enrichment** (`src/core/detect/git-context.ts`) — injects branch name and last commit message into the review prompt as `Change context: branch: feat/x | last commit: add user auth` so the LLM understands intent
- `ReviewInput.context.gitSummary` — new context field; all five adapters (claude, gemini, codex, openai-compatible, auto) inject it when present
- 18 new tests (9 stack + 9 protected-paths) — **199 total**

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
