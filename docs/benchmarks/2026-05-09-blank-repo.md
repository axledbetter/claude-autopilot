# Blank-repo benchmark — 2026-05-09

> **What this measures.** The day-1 experience of using
> `claude-autopilot` (master at v7.1.5) on a true `git init` repo, end
> to end from "empty directory" to "feature shipped + tests passing."
>
> **Why.** The autopilot pipeline has shipped 12 PRs in a single
> session against the established `claude-autopilot` codebase (mature
> CLAUDE.md, established patterns, tsc-regression baseline). That's
> the easy mode. The hard mode is "you just opened terminal and want
> to ship something." This benchmark measures that hard mode honestly.
>
> **Triggered by:** the codex pass on the autopilot product-direction
> brainstorm, finding W5 — "run the blank-repo benchmark BEFORE
> templates so the result is fair, then again after."

## Setup

* Test idea: `url-summarizer` — small Node 22 ESM CLI that takes a
  URL, fetches the page, calls Anthropic Claude (Haiku 4.5) for a
  3-bullet markdown summary, prints to stdout.
* Reasoning: small enough to ship in one autopilot loop; real enough
  to exercise a network dep, an external LLM, error handling, and a
  test split (unit + CLI subprocess).
* Operator role: I drove the full loop in this session — wrote the
  spec, ran one codex pass, dispatched an impl agent, measured the
  result. NOT a true autonomous run (the brainstorming dialogue would
  have required user input that I substituted for myself).
* Phase A: blank repo + `claude-autopilot setup`.
* Phase B: spec + 1 codex pass + impl agent + manual e2e verify.

## Results

### Phase A: setup

| Step | Wall clock | Output |
|---|---|---|
| `mkdir + git init + commit` | ~2s | 1 file (`README.md`) |
| `claude-autopilot setup` | **1.1s** | 1 new file (`guardrail.config.yaml`, 53 lines), 2 git hooks (`pre-commit`, `pre-push`) |
| `claude-autopilot doctor` (no env keys) | 0.9s | 2 warnings: missing env file, missing LLM key |
| Copy `.env.local` with keys | ~1s | 0 new files (gitignored) |
| `claude-autopilot doctor` (with keys) | 0.9s | "All checks passed — ready to run" |

**Phase A total: ~6 seconds.** Setup is genuinely instant on a blank
repo. The auto-generated `guardrail.config.yaml` has reasonable
defaults — `failOn: critical`, security static rules enabled,
protected paths for `auth/payment/encryption/secret/keys`. The
pre-commit hook ran in ~650ms on every commit and never had a
false positive on this codebase.

### Phase B: spec + impl + verify

| Step | Wall clock | Notes |
|---|---|---|
| Hand-write spec (`docs/specs/url-summarizer-mvp.md`, 38 lines) | ~5 min | Operator wrote it; would normally come out of brainstorming dialogue |
| `npx tsx scripts/codex-review.ts` (1 pass) | **44s** | 870 input + 1641 output tokens. Returned 0 CRITICAL + 6 WARNING + 3 NOTE — all real, all folded inline |
| Spec rewrite to fold codex findings | ~3 min | TypeScript→JS-only, prompt contract for 3-bullet output, fetch timeout, content-type filter, model name fix |
| `git commit` (pre-commit hook ran) | 1s | **Pre-commit caught all 4 secrets in `.env.local` when accidentally staged.** Added `.env.local` to `.gitignore`, recommitted clean. |
| Dispatch impl agent (background) | ~5 min | Subagent wrote 8 files (package.json + lockfile + tsconfig + bin + src + 2 test files + README), made 3 incremental commits |
| `npm test` | <1s | 7/7 pass (3 unit + 4 CLI subprocess) |
| `npx tsc --noEmit` | <2s | 0 errors |
| Manual `node bin/url-summarizer.js https://example.com` | ~3s | 3 markdown bullets, exit 0, real Anthropic API call (~$0.001) |

**Phase B total: ~13 minutes** (operator + agent wall clock).

## What worked

1. **`claude-autopilot setup` is genuinely fast and useful.** ~1s,
   produces a sensible config + hook pair, no friction.
2. **Pre-commit static-rules hook caught a real-world mistake on day 1.**
   I accidentally staged `.env.local` (which I'd just copied in for
   the API keys); the hook surfaced 4 CRITICAL findings (AWS key,
   Stripe live key, Twilio SID, JWT-shaped string) and blocked the
   commit. Saved a ~$5k blast radius if pushed.
3. **One-pass codex on a 38-line spec returned actionable findings in
   under a minute.** All 6 WARNINGs were real (TypeScript/JS layout,
   subprocess test injection, fetch timeout, URL scheme validation,
   model name typo, network failure exit-code semantics). Folded
   inline in ~3 min.
4. **Impl agent shipped to working code in ~5 min** with 7/7 tests
   green and clean typecheck. Made 3 incremental commits with
   reasonable messages. Found one footgun (sync subprocess deadlocks
   in-process HTTP server) and fixed it during impl.

## What didn't work / friction

1. **No CLAUDE.md scaffolded by `setup`.** The agent had to guess at
   commit-message style, error class shape, test runner choice,
   prompt location. All decisions were defensible but every guess
   was an opportunity for inconsistency on a real project.
2. **Spec/impl mismatch on small details.** Spec said `--import=tsx
   tests/*.test.js` and `spawnSync` for CLI tests — the agent had to
   correct both during impl (tsx unnecessary on JS-only repo;
   `spawnSync` blocks the parent loop and deadlocks in-process
   servers). One-pass codex didn't catch these (a 3-pass cycle on a
   spec this small would have been overkill).
3. **`claude-autopilot scan` was never invoked during impl.** The
   pre-commit hook is the only autopilot surface that runs without
   being asked, and it covered what `scan` would have surfaced.
   For a project this small, `validate` at the end is also redundant
   — `npm test` + `npx tsc --noEmit` IS what `validate` does.
4. **Deprecation banner prints on every commit.** The
   `guardrail` → `claude-autopilot` rename notice (multi-line yellow)
   prints on every pre-commit invocation. Fix: dedup to once-per-
   session via env var or `~/.claude-autopilot/.deprecation-shown`
   stamp file.
5. **`tsconfig.json` for a JS-only package with `allowJs + checkJs +
   noEmit` is non-obvious.** First-try forgot `types: ["node"]`. The
   agent caught it pre-commit but a CLAUDE.md hint would have
   collapsed this to copy-paste.
6. **No "I have a spec, scaffold the project" verb.** The biggest
   high-friction part of day-1 was scaffolding `package.json`,
   `tsconfig.json`, `.gitignore` patterns. A `claude-autopilot
   scaffold --from-spec docs/specs/foo.md` verb would collapse this.

## Wall-clock breakdown

| Bucket | Time |
|---|---|
| Phase A setup (mkdir → doctor green) | ~6s |
| Operator: spec write (3 dialog steps + 1 codex pass + folding findings) | ~9 min |
| Impl agent (background) | ~5 min |
| Operator: verify + benchmark notes | ~3 min |
| **Total: blank repo → working MVP** | **~17 min** |

For comparison: equivalent-scope features in the established
`claude-autopilot` codebase this session (e.g. v7.1.1 dual-secret
rotation, v7.1.2 configurable TTL) shipped in ~30-45 min each —
because they had spec PR + impl PR + CI + codex PR pass + admin merge.
The blank-repo benchmark is FASTER because there's no GH PR loop, no
CI, no second codex pass — but the resulting code has zero CI
coverage and no peer review.

## Recommendations (prioritized)

### Ship-now (small)

1. **Dedup the `guardrail` → `claude-autopilot` deprecation notice
   to once-per-session.** Multi-line yellow banner on every commit
   is genuinely annoying. ~30 min change in `bin/_launcher.js`.
2. **Auto-add `node_modules/` and `.guardrail-cache/` to `.gitignore`
   on `setup`.** Currently the user gets a `.gitignore` with only
   `.env.local`; adding the autopilot-specific cache dir is a
   one-liner. ~10 min change in `setup` verb.

### Ship-soon (medium)

3. **Auto-scaffold a starter `CLAUDE.md` on `setup`.** Detect
   stack + write a 20-line CLAUDE.md with: detected language, test
   command, commit-message style, default error class pattern,
   "patterns to mimic" anchor. Would close ~5 of the 6 friction
   points above. ~2-4 hr change in `setup` verb.
4. **`claude-autopilot scaffold --from-spec` verb.** Read a spec
   markdown file, scaffold `package.json` + `tsconfig.json` + dir
   structure described in the spec's "Files" section. Would collapse
   ~6 min of operator work per benchmark to ~30s. ~1-day ship.

### Defer to v8

5. **Autopilot's brainstorming dialogue needs to work without a
   human user-review gate** for a true "fully autonomous from blank
   repo" run. This is part of the standalone-daemon (Option C) spec
   and depends on the trust/permission model from codex C1+C2.

## Methodology caveats

* **n=1.** One small CLI on one stack (Node 22 ESM). A real benchmark
  suite would cover at least: blank Python repo (FastAPI + pytest),
  blank Rust repo (cargo + cargo test), blank Go repo (modules +
  table tests), and the same idea via `--template` once templates
  exist. Codex pass-1 NOTE #1 from the product-direction brainstorm
  flagged this exact gap — accepted as v8 follow-up.
* **Operator-driven, not agent-driven.** I wrote the spec, drove the
  codex pass, dispatched the impl agent. A true autonomous run would
  require the brainstorming skill to operate without user dialogue
  (Option C dependency). The impl-agent portion (Phase B middle) IS
  representative of what a real autonomous loop would look like.
* **No CI loop.** Skipped `gh pr create` + GH Actions + bugbot +
  codex PR pass. Those add ~10-15 min per PR on the established
  codebase and would presumably add similar overhead here. The "~17
  min" headline number is impl-only; a full PR-and-merge loop on
  this size feature would land in ~30-40 min.

## Raw artifacts

* Test repo: `/tmp/blank-benchmark/url-summarizer/` (5 commits on
  master, NOT pushed to GitHub).
* Setup log: `/tmp/blank-benchmark/setup.log`.
* Codex spec-pass output: `/tmp/blank-benchmark/codex-spec.log`.
* Agent's honest field notes: `/tmp/blank-benchmark/agent-notes.md`.

These are local-only and will not be pushed; they're referenced here
for the operator to inspect during PR review.
