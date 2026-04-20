# claude-autopilot v1.0 — Design Spec

**Date:** 2026-04-20
**Status:** Approved (pending implementation)
**Scope:** v0.1 → v1.0 clean-break redesign. Single cohesive design, landed as phased PRs.
**Current repo:** https://github.com/axledbetter/claude-autopilot (v0.1)
**Package name:** `@delegance/claude-autopilot` (npm)

---

## 1. Problem Statement

`claude-autopilot` v0.1 is a starter kit extracted from an internal deployment. It works, but the README itself says users "expect to rewrite `phase1-static.ts` and `bugbot.ts` for your codebase." The fork-and-adapt burden is the main barrier to broader use.

Four integration points are hardcoded into the scripts:

1. **Review engine** — only OpenAI Codex (`gpt-5.3-codex`)
2. **VCS host** — only GitHub via `gh` CLI
3. **Migration runner** — Supabase CLI, stubbed; no other DB tool supported
4. **Review-bot parser** — `cursor[bot]` with string-heuristic severity parsing

The config surface is essentially one file (`.autopilot/stack.md` for LLM prompt context) plus hardcoded constants scattered across scripts (`PROTECTED_PATTERNS`, `CONFIDENCE_THRESHOLDS`, rule lists, bot author names).

No test harness. Large PRs truncate at 15 000 chars. Observability is `console.log` plus two JSON report files.

---

## 2. Goals

**G1.** Users can onboard a new stack (Rails, Python, Go) by picking a preset and editing YAML — no code changes for the common case.
**G2.** Users can swap any of the four integration points by providing a TypeScript adapter file and a config line.
**G3.** Scenario tests (≥20) catch regressions in pipeline phase transitions, parsers, and state machines.
**G4.** Large PRs (beyond token budget) get a review instead of a truncated one. Reviewer knows when the review is partial.
**G5.** Every run produces a machine-readable artifact and an NDJSON event stream for downstream telemetry.
**G6.** Package published to npm with stable CLI surface; internal refactors don't break users.

**Non-goals (deferred to v1.1+):**
- Map-reduce chunking strategy for massive PRs
- Multiple review bots running concurrently
- GitLab / Bitbucket VCS support
- OpenTelemetry span emission (the field names are OTel-compatible but no collector integration)
- A v0.1 → v1.0 automated migrator (release notes cover manual steps)

---

## 3. Architecture

### 3.1 Module layout

```
claude-autopilot/
├── src/                                # was scripts/, renamed for publish
│   ├── core/
│   │   ├── pipeline.ts                 # top-level orchestrator
│   │   ├── phases/
│   │   │   ├── static-rules.ts         # unified static checks + autofix (replaces phase1+phase2+phase3)
│   │   │   ├── tests.ts
│   │   │   ├── review.ts               # spec-aware code review via configured engine
│   │   │   └── gate.ts                 # merge gate (review-bot findings summary)
│   │   ├── chunking/
│   │   │   ├── tier-selector.ts
│   │   │   ├── single-pass.ts
│   │   │   └── file-level.ts
│   │   ├── logging/
│   │   │   ├── ndjson-writer.ts
│   │   │   └── run-artifact.ts
│   │   ├── config/
│   │   │   ├── loader.ts
│   │   │   ├── schema.ts               # JSON Schema for YAML config
│   │   │   ├── preset-resolver.ts
│   │   │   └── adapter-loader.ts       # resolve + validate adapter modules
│   │   └── findings/
│   │       ├── types.ts                # Finding, TriageRecord, FixAttempt (shared currency)
│   │       └── dedup.ts
│   ├── adapters/
│   │   ├── review-engine/
│   │   │   ├── types.ts                # ReviewEngine interface
│   │   │   ├── codex.ts
│   │   │   └── claude.ts
│   │   ├── vcs-host/
│   │   │   ├── types.ts
│   │   │   └── github.ts
│   │   ├── migration-runner/
│   │   │   ├── types.ts
│   │   │   ├── supabase.ts
│   │   │   ├── prisma.ts
│   │   │   ├── alembic.ts
│   │   │   ├── rails.ts
│   │   │   └── golang-migrate.ts
│   │   └── review-bot-parser/
│   │       ├── types.ts
│   │       ├── declarative-base.ts     # base class for YAML-driven parsers
│   │       ├── cursor.ts
│   │       ├── coderabbit.ts
│   │       ├── greptile.ts
│   │       └── sourcery.ts
│   ├── cli/                            # public CLI — stable surface
│   │   ├── autopilot.ts                # main entry, subcommands below
│   │   ├── preflight.ts
│   │   ├── validate.ts
│   │   ├── validate-config.ts          # NEW: read-only config validator
│   │   ├── codex-pr-review.ts
│   │   └── bugbot.ts
│   └── testing/                        # PUBLIC: exported for downstream test harnesses
│       ├── fake-llm.ts
│       ├── fake-vcs.ts
│       ├── fake-git.ts
│       └── fixtures/                   # re-exported fixture loaders
├── presets/
│   ├── nextjs-supabase/
│   ├── t3/
│   ├── rails-postgres/
│   ├── python-fastapi/
│   └── go/
├── tests/
│   ├── fixtures/                       # llm/, gh-api/, git-repos/, configs/
│   └── *.test.ts                       # 20+ scenario tests
├── .claude/skills/
│   ├── autopilot/SKILL.md              # stack-agnostic; delegates to CLI
│   └── migrate/SKILL.md                # delegates to configured migration runner
├── autopilot.config.yaml               # user config (YAML-only for v1.0)
└── package.json                        # bin: { "autopilot": "./dist/cli/autopilot.js" }
```

### 3.2 Pipeline flow

```
spec (input) ─▶ plan ─▶ worktree ─▶ implement ─▶ migrate ─▶ validate ─▶ push+PR ─▶ PR review ─▶ review-bot triage ─▶ report
                                                           │                                                             │
                                                           ▼                                                             ▼
                                                  static-rules phase                                            run artifact JSON
                                                  tests phase                                                   NDJSON event log
                                                  review phase (chunked)
                                                  gate phase
```

Every phase emits NDJSON events: `phase.start`, `phase.end`, `finding.created`, `triage.recorded`, `fix.attempted`, `fix.reverted`, `phase.retry`.

---

## 4. Integration-Point Interfaces

All interfaces live at `src/adapters/<point>/types.ts` and re-export from `@delegance/claude-autopilot/adapters`.

### 4.1 `ReviewEngine`

```typescript
interface ReviewEngine {
  name: string;
  review(input: ReviewInput): Promise<ReviewOutput>;
  estimateTokens(content: string): number;  // for tier selector
}

interface ReviewInput {
  content: string;
  kind: 'spec' | 'pr-diff' | 'file-batch';
  context?: { spec?: string; plan?: string; stack?: string };
}

interface ReviewOutput {
  findings: Finding[];
  rawOutput: string;
  usage?: { input: number; output: number };
}
```

Built-ins: `codex`, `claude`.

### 4.2 `VcsHost`

```typescript
interface VcsHost {
  name: string;
  getPrDiff(pr: number | string): Promise<string>;
  getPrMetadata(pr: number | string): Promise<PrMetadata>;
  postComment(pr: number | string, body: string): Promise<void>;
  getReviewComments(pr: number | string): Promise<GenericComment[]>;
  replyToComment(pr: number | string, commentId: string | number, body: string): Promise<void>;
  createPr(opts: CreatePrOptions): Promise<{ number: number; url: string }>;
  push(branch: string, opts?: { setUpstream?: boolean }): Promise<void>;
}
```

Built-ins: `github` (only).

### 4.3 `MigrationRunner`

```typescript
interface MigrationRunner {
  name: string;
  discover(touchedFiles: string[]): Migration[];            // find candidate migrations
  dryRun(migration: Migration): Promise<DryRunResult>;
  apply(migration: Migration, env: 'dev' | 'qa' | 'prod'): Promise<ApplyResult>;
  ledger(env: 'dev' | 'qa' | 'prod'): Promise<LedgerEntry[]>;   // [] if runner has no ledger
}
```

Built-ins: `supabase`, `prisma`, `alembic`, `rails`, `golang-migrate`.

### 4.4 `ReviewBotParser`

```typescript
interface ReviewBotParser {
  name: string;
  detect(comment: GenericComment): boolean;
  fetchFindings(vcs: VcsHost, pr: number | string): Promise<Finding[]>;
  detectDismissal(reply: string): boolean;
}
```

Built-ins: `cursor`, `coderabbit`, `greptile`, `sourcery`.

`DeclarativeReviewBotParser` is the base class: configured via YAML fields (`author`, `severity` regex map, `dismissal` keyword list), covers ~80% of bots without custom code.

---

## 5. Config Surface

### 5.1 `autopilot.config.yaml`

YAML is the single config format for v1.0. JSON Schema published at `@delegance/claude-autopilot/schema.json` for editor autocomplete via `# yaml-language-server: $schema=...`.

```yaml
# yaml-language-server: $schema=https://unpkg.com/@delegance/claude-autopilot@1/schema.json

preset: nextjs-supabase                  # optional — merges preset defaults under user overrides

reviewEngine:
  adapter: codex                         # built-in name OR relative path "./adapters/my-engine.ts"
  # options: { model: "gpt-5.3-codex", maxOutputTokens: 4096 }

vcsHost:
  adapter: github

migrationRunner:
  adapter: supabase
  options:
    projectRefs: { dev: "abc123", qa: "def456", prod: "xyz789" }
    deltasDir: "data/deltas"

reviewBot:                               # singular in v1.0; v1.1 may accept array
  adapter: cursor

protectedPaths:                          # auto-fix blocked on these (moved from code constant)
  - "**/auth/**"
  - "data/deltas/*.sql"
  - "middleware.ts"

staticRules:                             # composable plugins; preset provides defaults
  - hardcoded-secrets                    # built-in, always-on
  - npm-audit
  - package-lock-sync
  - supabase-rls-bypass                  # preset-supplied (see §8)
  - adapter: "./rules/my-custom.ts"      # user custom rule

stack: |
  # Free-text stack description (replaces .autopilot/stack.md).
  # Loaded as Codex system-prompt context.
  A Next.js 16 App Router app with Supabase + Weaviate…

thresholds:
  bugbotAutoFix: 85
  bugbotProposePatch: 60
  maxValidateRetries: 3
  maxCodexRetries: 2
  maxBugbotRounds: 3

reviewStrategy: auto                     # auto | single-pass | file-level
chunking:
  smallTierMaxTokens: 8000               # single-pass threshold
  partialReviewTokens: 60000             # beyond this, mark review partial + warn
```

### 5.2 Adapter-path validation (fail-fast)

At config load time, `adapter-loader.ts`:

1. Resolves the adapter identifier — built-in name OR relative TS path.
2. For path adapters: imports the module, verifies it exports the required methods for the interface, fails fast with a pointed diagnostic naming the missing method and expected signature.
3. For built-ins: tree-shakes unused adapters at build time.

### 5.3 Preset resolution

`preset: nextjs-supabase` triggers:

1. Load `presets/nextjs-supabase/autopilot.config.yaml` as the base.
2. Merge user's `autopilot.config.yaml` on top (user wins on scalar conflicts; arrays are replaced not concatenated — keeps merging predictable).
3. Load `presets/nextjs-supabase/stack.md` as default `stack` field (user's `stack:` field wins if set).

---

## 6. Unified `Finding` + History Types

Single shared currency for validate and review-bot outputs.

```typescript
// src/core/findings/types.ts

interface Finding {
  id: string;                            // stable hash: {source, file, line, messageHead}
  source: FindingSource;                 // 'static-rules' | 'review-engine' | 'review-bot:<name>'
  severity: 'critical' | 'warning' | 'note';
  category: string;                      // e.g. 'npm-audit', 'codex-review', 'bugbot-high'
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  protectedPath: boolean;
  createdAt: string;                     // ISO timestamp
}

interface TriageRecord {
  findingId: string;
  verdict: 'real_bug' | 'false_positive' | 'low_value';
  confidence: number;                    // 0-100
  reason: string;
  action: 'auto_fix' | 'propose_patch' | 'ask_question' | 'dismiss' | 'needs_human';
  recordedAt: string;
}

interface FixAttempt {
  findingId: string;
  attemptedAt: string;
  status: 'fixed' | 'reverted' | 'human_required' | 'skipped';
  commitSha?: string;
  notes?: string;
}
```

Rationale: separating identity (Finding) from lifecycle (TriageRecord[], FixAttempt[]) preserves audit trail — multiple triage attempts, superseded fixes — and serializes cleanly into the NDJSON event stream without mutation conflicts.

---

## 7. Static-Rules Phase (merged phase 1 + 2 + 3)

### 7.1 `StaticRule` plugin shape

```typescript
interface StaticRule {
  name: string;
  severity: 'critical' | 'warning' | 'note';
  check(touchedFiles: string[]): Promise<Finding[]>;
  autofix?(finding: Finding): Promise<'fixed' | 'reverted' | 'skipped'>;
}
```

Built-in rules (always-on, stack-agnostic):
- `hardcoded-secrets` — regex scan, no autofix
- `npm-audit` — `npm audit --json`, no autofix
- `package-lock-sync` — regenerates lockfile, autofix stages result
- `eslint` — runs `eslint --fix`, autofix applies
- `console-log` — scan for `console.log`, suggests logger, no autofix

Preset rules (§8): added per-preset via config, each preset supplies 1–3 invariant security checks.

### 7.2 Runner logic

```
1. Load rules from config.
2. For each rule: call check() → collect findings.
3. For findings where rule.autofix exists AND finding is not on a protected path:
   a. Snapshot modified files.
   b. Call autofix(finding).
   c. On 'fixed': mark finding status, keep working tree.
   d. On 'reverted': restore snapshot.
4. If any autofix ran: re-run ALL rules.check() once (cheap global re-check).
   Findings from re-check replace prior findings. Re-check does NOT re-run autofix —
   prevents ping-pong on rules that disagree.
5. Phase status:
   pass  = no critical findings
   warn  = warnings only
   fail  = any unfixed critical
```

Rationale for global re-check (from Codex feedback): selective re-eval (only rules whose autofix ran) misses second-order interactions — e.g., `eslint` removing unused imports can invalidate `hardcoded-secrets` matches on those import lines. Global re-check is cheap (rules are file scans) and keeps findings consistent.

---

## 8. Chunking Strategy (large-PR review)

### 8.1 Tiers

| Tier | Trigger | Behavior |
|---|---|---|
| `single-pass` | tokens ≤ `smallTierMaxTokens` (default 8 000) | Current behavior: one review call. |
| `file-level` | tokens > smallTier AND ≤ `partialReviewTokens` (default 60 000) | Split diff by file → one review call per file with 2 nearest imported files as context → aggregate + dedup findings. |
| `partial-review` (NEW) | tokens > partialReviewTokens | Run `file-level` but emit `partialReview: true` on run artifact AND post a dedicated PR comment: "⚠️ PR size exceeded review budget; file-level review performed without cross-file analysis. Consider splitting." |

Selector defaults to `auto`; users can force via `reviewStrategy: file-level`.

### 8.2 Finding dedup (file-level mode)

Findings aggregated across per-file reviews are deduplicated on `(file, line, severity, hash(message[:40]))`. Ties broken by confidence if reported, else by severity rank.

### 8.3 Non-goals

Map-reduce tier is deferred to v1.1. The reasoning: ≥60k-token PRs are a small minority; when they occur, the human reviewer should split the PR. A reduce-pass LLM call adds cost without materially improving large-refactor review quality. `partialReview` flag is the honest answer.

---

## 9. Observability

### 9.1 NDJSON event log

Path: `.claude/logs/<run-id>.ndjson`. One event per line, machine-parseable.

```jsonc
{ "ts": "2026-04-20T14:32:01.123Z", "runId": "2026-04-20-1432-claude-autopilot-v1", "event": "pipeline.start", "topic": "claude-autopilot-v1", "specFile": "docs/superpowers/specs/..." }
{ "ts": "...", "event": "phase.start", "phase": "static-rules" }
{ "ts": "...", "event": "finding.created", "findingId": "...", "source": "static-rules", "severity": "warning", "file": "src/x.ts", "line": 42, "category": "console-log" }
{ "ts": "...", "event": "fix.attempted", "findingId": "...", "status": "fixed", "commitSha": "abc1234" }
{ "ts": "...", "event": "phase.end", "phase": "static-rules", "durationMs": 4210, "status": "pass" }
{ "ts": "...", "event": "phase.retry", "phase": "validate", "attempt": 2, "reason": "codex_critical_findings" }
{ "ts": "...", "event": "adapter.call", "adapter": "review-engine.codex", "durationMs": 8234, "tokensIn": 12040, "tokensOut": 420 }
{ "ts": "...", "event": "pipeline.end", "verdict": "PASS", "durationMs": 842101 }
```

Field names follow OpenTelemetry conventions (`ts`, `durationMs`, `status`, `attempt`, etc.) so users can pipe logs to any collector later.

### 9.2 Run summary artifact

Path: `.claude/runs/<run-id>.json`. Single JSON, summary of the whole run.

```jsonc
{
  "runId": "2026-04-20-1432-claude-autopilot-v1",
  "topic": "claude-autopilot-v1",
  "startedAt": "...", "endedAt": "...", "durationMs": 842101,
  "verdict": "PASS",
  "specFile": "...", "planFile": "...", "branch": "...", "prUrl": "...", "prNumber": 123,
  "phases": [{"name":"plan","status":"pass","durationMs":42110}, ...],
  "retries": [{"phase":"validate","attempt":2,"reason":"..."}],
  "findings": {
    "static-rules": { "critical": 0, "warning": 2, "note": 3, "autoFixed": 2 },
    "review-engine": { "critical": 0, "warning": 1, "note": 4 },
    "review-bot:cursor": { "high": 0, "medium": 1, "low": 4 }
  },
  "adapterCalls": {
    "review-engine.codex": { "calls": 5, "totalMs": 34210, "totalInputTokens": 82000, "totalOutputTokens": 3200 }
  },
  "partialReview": false,
  "humanRequired": [{"phase":"bugbot","findingId":"...","reason":"..."}]
}
```

### 9.3 Retention

`.claude/logs/` and `.claude/runs/` are gitignored by default. Users who want retention ship them to their own log aggregator via filesystem watcher or post-run hook (documented, not implemented in v1.0).

---

## 10. Test Harness

### 10.1 Framework

Node built-in `node:test` + `node:assert`. Zero test-framework dependencies (this is a tool others install as a dev dep — keeping our dep surface thin matters).

### 10.2 Fake clients

```
src/testing/fake-llm.ts     — FakeReviewEngine. Replays recorded NDJSON fixtures or canned responses.
src/testing/fake-vcs.ts     — FakeVcsHost. In-process; holds comments/PRs in memory.
src/testing/fake-git.ts     — Wraps real git in a temp repo initialized from a tarball fixture.
```

Exported from `@delegance/claude-autopilot/testing` for downstream users testing their own adapters.

### 10.3 Scenario catalog (20 tests)

```
tests/
├── preflight.test.ts                   3 tests
│   ├─ missing Node 22 → fails with actionable message
│   ├─ missing gh auth → fails pointing to `gh auth login`
│   └─ warnings-only config → exits 0 with warnings summary
├── static-rules-phase.test.ts          4 tests
│   ├─ clean diff → passes, zero findings
│   ├─ critical secret → fails, no autofix (protected rule class)
│   ├─ autofix applies + global re-check runs
│   └─ protected path → autofix skipped, finding marked protected
├── review-engine-parser.test.ts        3 tests
│   ├─ valid Codex output → parses into findings
│   ├─ truncated output → graceful degrade, warning finding
│   └─ malformed markdown → no crash, empty findings + warn
├── chunking-tier-selector.test.ts      3 tests
│   ├─ small PR → single-pass
│   ├─ medium PR → file-level
│   └─ huge PR → file-level + partialReview=true + PR warning comment
├── bugbot-state-transitions.test.ts    4 tests
│   ├─ new comment → triaged → ai-dismissed (false-positive, high confidence)
│   ├─ ai-dismissed → human-dismissed when reply "false positive"
│   ├─ real_bug high confidence → auto_fix → committed + pushed
│   └─ real_bug + fix fails → status needs-human, merge gate blocks
└── config-loader.test.ts               3 tests
    ├─ valid config → loaded + preset merged
    ├─ invalid YAML → schema error with line + column
    └─ custom adapter path missing method → fails fast with pointed diagnostic

Total: 20 tests.
```

### 10.4 Fixtures

```
tests/fixtures/
├── llm/                                NDJSON recordings of real Codex responses
├── gh-api/                             JSON fixtures for gh CLI responses
├── git-repos/                          Tarballs: clean/, with-secrets/, with-migration/
└── configs/                            valid-nextjs.yaml, invalid-yaml.txt, missing-adapter.yaml
```

---

## 11. Presets

Each preset is a directory with three files:

```
presets/nextjs-supabase/
├── autopilot.config.yaml       # defaults users inherit via `preset: nextjs-supabase`
├── stack.md                    # Codex system-prompt context
└── rules/                      # 1–3 invariant security rules per preset (see Codex feedback)
    ├── supabase-rls-bypass.ts
    └── weaviate-tenant-missing.ts
```

### 11.1 Per-preset defaults

| Preset | Migration runner | Test runner | Invariant security rules (hand-written, narrow scope) |
|---|---|---|---|
| **nextjs-supabase** | `supabase` (CLI + ledger) | `npm test` (jest/vitest autodetect) | supabase-rls-bypass, weaviate-tenant-missing, resend-sender-domain |
| **t3** | `prisma` (`migrate deploy` + `_prisma_migrations` ledger) | `npm test` | prisma-raw-query, trpc-unprotected-public-procedure |
| **rails-postgres** | `rails` (`bin/rails db:migrate` + `schema_migrations` table) | `bundle exec rspec` | mass-assignment-permit-all, strong-params-missing |
| **python-fastapi** | `alembic` (`alembic upgrade head` + `alembic_version` table) | `pytest` | sqlalchemy-raw-execute, missing-pydantic-validation |
| **go** | `golang-migrate` (+ `schema_migrations` table) | `go test ./...` | sql-exec-without-context, http-handler-without-timeout |

### 11.2 Why preset code is bounded to invariant rules

Per Codex review (§S6 rebuttal): LLM-only enforcement of security invariants is probabilistic and model-version-sensitive. Hand-written rules for truly invariant patterns (RLS bypass, raw SQL exec) remain deterministic. Probabilistic checks (design-level security, architectural drift) stay in `stack.md` for the review-engine prompt.

**Limit:** 1–3 rules per preset, each ≤100 lines. Contributors adding a 4th rule must justify it as invariant-class.

### 11.3 Review-bot defaults

Every preset's `autopilot.config.yaml` defaults to `reviewBot: { adapter: cursor }`. Users change it with one line. All four built-in bot parsers (cursor, coderabbit, greptile, sourcery) ship with every preset — no preset-specific bot bundling.

---

## 12. Migration Plan (v0.1 → v1.0)

### 12.1 Breaking changes

| What | Before | After |
|---|---|---|
| Script directory | `scripts/` | `src/` (published as `dist/` in npm package) |
| CLI entry | `npx tsx scripts/validate.ts` | `npx autopilot validate` (from package) |
| Config file | `.autopilot/stack.md` only | `autopilot.config.yaml` + `stack` field |
| Protected paths | `PROTECTED_PATTERNS` in `src/core/phases/static-rules.ts` constant | `protectedPaths` array in config |
| Phase count | phase1/2/3 + tests + codex + gate | static-rules + tests + review + gate |
| Finding types | `Finding` + `BugbotComment` + `TriageResult` + `FixResult` | `Finding` + `TriageRecord[]` + `FixAttempt[]` |

### 12.2 v0.1 user migration

No automated migrator (release notes instead). v0.1 has ~0 external users.

Release notes will include:

```bash
# Move stack.md contents into config
npx autopilot validate-config --write-stub   # writes autopilot.config.yaml with your stack.md embedded
```

`validate-config` command is read-only in general; `--write-stub` is the single-use shortcut for v0.1 → v1.0.

### 12.3 Release cadence

- **v1.0.0-alpha.1** — architecture in place, adapters stubbed, 1 preset (nextjs-supabase), 5 tests
- **v1.0.0-alpha.2** — all 4 adapters wired, all 5 presets, all 20 tests
- **v1.0.0-beta.1** — internal dogfooding on Delegance for 2 weeks
- **v1.0.0** — public npm publish

---

## 13. Risks & Open Questions

### 13.1 Risks

| Risk | Mitigation |
|---|---|
| Adapter interface churn during alpha forces downstream rewrites | Alpha releases explicitly marked unstable; lock interfaces before beta |
| `partialReview` flag is ignored by users → low-quality reviews ship | PR comment is prominent + verdict annotation + CI gate hint documented |
| Per-preset invariant rules drift from underlying stack conventions | Contributor guide requires each rule to cite the stack convention it enforces |
| NDJSON log size on long runs | Retention guide: rotate by run-id, gitignore by default |
| `node:test` maturity for snapshot testing | We don't use snapshots; assertions are explicit. Reassess for v1.1 if needed |

### 13.2 Open questions

None blocking implementation. Documented decisions:

- **Package org:** `@delegance/claude-autopilot` (using npm token user has confirmed). Could be renamed later; CLI name `autopilot` stays the same.
- **Node minimum:** 22 (current), per existing preflight check.
- **License:** MIT (unchanged).
- **Telemetry:** none in v1.0. NDJSON logs are local-only. Opt-in usage telemetry is a v1.1 discussion.

---

## 14. Implementation Order (for writing-plans to consume)

1. **Core scaffolding** — `src/core/findings/types.ts`, `src/core/config/`, `src/core/logging/`. No adapters yet.
2. **Interface definitions** — `src/adapters/*/types.ts` for all four integration points.
3. **Migrate current adapters** — port existing Codex, GitHub, Supabase, cursor-bot code behind new interfaces.
4. **Unified static-rules phase** — merge phase1+2+3 with global re-check; convert existing rules to `StaticRule` plugins.
5. **Chunking** — implement tier-selector, single-pass, file-level, partialReview annotation.
6. **NDJSON + run artifact** — wire into orchestrator and phases.
7. **New adapters** — claude review-engine, prisma/alembic/rails/golang-migrate runners, coderabbit/greptile/sourcery bot parsers.
8. **Presets** — 5 preset directories with config + stack.md + invariant rules.
9. **Test harness** — fakes + 20 scenario tests.
10. **CLI + package** — bin field, publish config, schema export, `validate-config` command.
11. **Skill updates** — rewrite `.claude/skills/autopilot/SKILL.md` to delegate to new CLI.
12. **Dogfood + beta** — run against Delegance main repo for 2 weeks; iterate.
13. **Release** — npm publish v1.0.0, README rewrite, announce.
