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
**G3.** Scenario tests (≥20 scenario + ≥20 adapter conformance) catch regressions in pipeline phase transitions, parsers, and state machines.
**G4.** Large PRs (beyond token budget) get a review instead of a truncated one. Reviewer knows when the review is partial.
**G5.** Every run produces a machine-readable artifact and an NDJSON event stream for downstream telemetry.
**G6.** Package published to npm with stable CLI surface; internal refactors don't break users.
**G7.** First-run onboarding under 60 seconds via `autopilot init`.
**G8.** CI integration is drop-in via per-preset GitHub Actions workflow templates.
**G9.** Pipeline is idempotent and resumable: a failed run at step N can be resumed at step N without duplicate side effects (PRs, migrations, comments).
**G10.** Default posture is secret-safe: raw prompts/responses/diffs not persisted unless explicitly opted in; artifacts retention bounded.
**G11.** Adapters declare their capabilities; orchestrator degrades gracefully when a capability is missing.

**Non-goals (deferred to v1.1+):**
- Map-reduce chunking strategy for massive PRs
- Multiple review bots running concurrently
- GitLab / Bitbucket VCS support
- OpenTelemetry span emission (the field names are OTel-compatible but no collector integration)
- Full rollback orchestration (reverting commits, rolling back migrations) — v1.0 ships *idempotent resume* only
- Automatic resolution of `autopilot-adapter-*` packages from node_modules (explicit allowlist only in v1.0)
- Partial-mode execution flags (`--from`, `--only`) beyond `--resume`
- Structured false-positive feedback loop for framework improvement
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

### 4.0 Adapter base contract (shared across all four interfaces)

Every adapter implements a shared base that the core pipeline uses to negotiate compatibility and drive retry policy:

```typescript
interface AdapterBase {
  name: string;
  apiVersion: string;                   // semver; orchestrator enforces major-version match
  getCapabilities(): Capabilities;       // declared features so core can degrade gracefully
}

interface Capabilities {
  [feature: string]: boolean | number | string;
  // Review engines:   structuredOutput, streaming, maxContextTokens, inlineComments
  // VCS hosts:        draftPrs, suggestedChanges, reviewThreads
  // Migration runners: ledger, dryRun, transactional, multiEnv
  // Review-bot parsers: lineComments, summaryComments, checks, humanDismissalDetect
}
```

Example: if `reviewEngine.getCapabilities().structuredOutput === false`, the core falls back to markdown parsing rather than requiring the adapter to emit JSON. The orchestrator refuses to start if `Math.floor(adapter.apiVersion) !== Math.floor(core.adapterApiVersion)` — this is the explicit version handshake.

### 4.1 `ReviewEngine`

```typescript
interface ReviewEngine extends AdapterBase {
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
  usage?: { input: number; output: number; costUSD?: number };  // cost populated from price table
}
```

Built-ins: `codex`, `claude`.

- **codex adapter** — uses OpenAI `responses.create()` with `gpt-5.3-codex`. `structuredOutput: false` (markdown parsed by core). `maxContextTokens: 128000`. System prompt = stack + findings-format rules.
- **claude adapter** — uses Anthropic Messages API with `claude-opus-4-7` (configurable via `CLAUDE_MODEL`). `structuredOutput: true` (tool use for findings JSON). `maxContextTokens: 1000000` (1M context beta). Extended thinking enabled by default for `kind: 'pr-diff'`. System prompt = stack + findings-format rules.

### 4.2 `VcsHost`

```typescript
interface VcsHost extends AdapterBase {
  getPrDiff(pr: number | string): Promise<string>;
  getPrMetadata(pr: number | string): Promise<PrMetadata>;
  postComment(pr: number | string, body: string, idempotencyKey?: string): Promise<void>;
  getReviewComments(pr: number | string): Promise<GenericComment[]>;
  replyToComment(pr: number | string, commentId: string | number, body: string, idempotencyKey?: string): Promise<void>;
  createPr(opts: CreatePrOptions & { idempotencyKey?: string }): Promise<{ number: number; url: string; alreadyExisted: boolean }>;
  push(branch: string, opts?: { setUpstream?: boolean }): Promise<void>;
}
```

`idempotencyKey` is populated by core from `(runId, step)`. `createPr` returns `alreadyExisted: true` if a PR for the same head branch already exists. `postComment` / `replyToComment` de-dup via stored-comment-hash check before API call.

Built-ins: `github` (only).

- **github adapter** — wraps `gh` CLI + REST API. Idempotency implemented via comment-body-hash lookup (GitHub's native idempotency-key header isn't available on all endpoints). `getCapabilities()`: `{ draftPrs: true, suggestedChanges: true, reviewThreads: true }`.

### 4.3 `MigrationRunner`

```typescript
interface MigrationRunner extends AdapterBase {
  discover(touchedFiles: string[]): Migration[];            // find candidate migrations
  dryRun(migration: Migration): Promise<DryRunResult>;
  apply(migration: Migration, env: 'dev' | 'qa' | 'prod'): Promise<ApplyResult>;
  ledger(env: 'dev' | 'qa' | 'prod'): Promise<LedgerEntry[]>;   // [] if runner has no ledger
  alreadyApplied(migration: Migration, env: 'dev' | 'qa' | 'prod'): Promise<boolean>;   // idempotency check
}
```

Built-ins: `supabase`, `prisma`, `alembic`, `rails`, `golang-migrate`.

- **supabase adapter** — wraps existing `scripts/supabase/migrate.ts` + Management API. Ledger is the `delegance_migrations` custom table. `discover` reads `data/deltas/*.sql`. `alreadyApplied` checks ledger.
- **prisma adapter** — shells to `prisma migrate deploy` per env. Ledger is `_prisma_migrations` table. `discover` reads `prisma/migrations/*/migration.sql`. `alreadyApplied` queries `_prisma_migrations.migration_name`.
- **alembic adapter** — shells to `alembic upgrade head` per env (configurable env name). Ledger is `alembic_version`. `discover` reads `alembic/versions/*.py`. `alreadyApplied` compares to current `alembic_version.version_num`.
- **rails adapter** — shells to `bin/rails db:migrate RAILS_ENV=<env>`. Ledger is `schema_migrations`. `discover` reads `db/migrate/*.rb`. `alreadyApplied` queries `schema_migrations.version`.
- **golang-migrate adapter** — shells to `migrate -path=migrations -database=<url> up`. Ledger is `schema_migrations` (customizable). `discover` reads `migrations/*.up.sql`.

### 4.4 `ReviewBotParser`

```typescript
interface ReviewBotParser extends AdapterBase {
  detect(comment: GenericComment): boolean;
  fetchFindings(vcs: VcsHost, pr: number | string): Promise<Finding[]>;
  detectDismissal(reply: string): boolean;
}
```

Built-ins: `cursor`, `coderabbit`, `greptile`, `sourcery`.

`DeclarativeReviewBotParser` is the base class: configured via YAML fields (`author`, `severity` regex map, `dismissal` keyword list), covers ~80% of bots without custom code.

- **cursor adapter** — matches author `cursor[bot]`. Severity regex: `/\bhigh\b|\bcritical\b/i` → HIGH, etc. Source: pr_review_comments.
- **coderabbit adapter** — matches author `coderabbitai[bot]`. Severity from emoji markers (⚠️ critical, 💡 suggestion, 📝 nit).
- **greptile adapter** — matches author `greptileai[bot]`. Severity from explicit `Severity: <level>` field in body.
- **sourcery adapter** — matches author `sourcery-ai[bot]`. Severity from issue-type prefix.

### 4.5 Error taxonomy (shared)

```typescript
class AutopilotError extends Error {
  code: ErrorCode;
  retryable: boolean;
  provider?: string;              // adapter name
  step?: string;                  // pipeline step
  details: Record<string, unknown>;
}

type ErrorCode =
  | 'auth'                // invalid/missing credentials
  | 'rate_limit'          // upstream rate-limited
  | 'transient_network'   // timeout, DNS, reset
  | 'invalid_config'      // user config error
  | 'adapter_bug'         // adapter returned malformed data
  | 'user_input'          // bad CLI arg, missing spec, etc.
  | 'budget_exceeded'     // cost budget hit
  | 'concurrency_lock'    // another run holds lock
  | 'superseded';         // newer commit superseded this run
```

Retry policy (in core, not adapter):

| `code` | Retry? | Max attempts | Backoff |
|---|---|---|---|
| `rate_limit` | yes | 5 | exponential with jitter |
| `transient_network` | yes | 3 | exponential |
| `auth`, `invalid_config`, `user_input` | no | — | fail fast |
| `adapter_bug` | no | — | fail fast, open bug |
| `budget_exceeded` | no | — | honor budget policy mode |
| `concurrency_lock`, `superseded` | no | — | exit 0 with "superseded" status |

Adapters throw `AutopilotError`. Core wraps unknown errors as `adapter_bug`.

---

## 5. Config Surface

### 5.1 `autopilot.config.yaml`

YAML is the single config format for v1.0. JSON Schema published at `@delegance/claude-autopilot/schema.json` for editor autocomplete via `# yaml-language-server: $schema=...`.

```yaml
# yaml-language-server: $schema=https://unpkg.com/@delegance/claude-autopilot@1/schema.json

configVersion: 1                         # schema version; migrate via `autopilot config migrate`
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

reviewBot:                               # singular in v1.0; v1.1 may accept array (object form reserved)
  adapter: cursor

# Adapter trust model: explicit path OR allowlisted package name only.
# No automatic autopilot-adapter-* resolution from node_modules.
adapterAllowlist:                        # optional; empty = only built-ins + relative paths permitted
  - "@delegance/autopilot-adapter-gitlab"   # opt in to specific packages; must be in package.json with pinned version

protectedPaths:                          # auto-fix blocked on these (moved from code constant)
  - "**/auth/**"
  - "data/deltas/*.sql"
  - "middleware.ts"

staticRules:                             # composable plugins; preset provides defaults
  - hardcoded-secrets                    # built-in, always-on
  - npm-audit
  - package-lock-sync
  - supabase-rls-bypass                  # preset-supplied (see §11)
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
  perFileMaxTokens: 32000                # if a single file exceeds this, partialReview fires for that file

cost:
  perRunBudgetUSD: 5.00                  # null to disable
  monthlyBudgetUSD: 500.00               # null to disable
  policy: warn                           # warn | stop-before-step | stop-immediate
  priceTable: builtin                    # builtin | path to custom YAML

cache:
  enabled: true
  scope: repo                            # repo | disabled (global scope not supported — security)
  ttlHours: 24
  skipIfContainsSecret: true             # pre-cache redaction check

persistence:                             # what's allowed to hit disk in NDJSON / run artifact / cache
  persistRawPrompts: false               # default: only token counts + content hashes
  persistRawResponses: false
  artifactRetentionDays: 30              # 0 = no automatic cleanup
  redactionPatterns:                     # default patterns applied to all persisted content
    - '(sk-[a-zA-Z0-9]{20,})'
    - '(eyJ[a-zA-Z0-9_-]{30,})'
    - '(ghp_[a-zA-Z0-9]{30,})'
    - '(xoxb-[a-zA-Z0-9-]{20,})'
    - '(AKIA[A-Z0-9]{16})'

concurrency:
  lockScope: repo+branch                 # lock key; prevents overlapping runs on same branch
  onConflict: abort                      # abort | cancel-existing
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

**Oversized single file (per G7):** If a single file's diff exceeds `chunking.perFileMaxTokens` (default 32 000), the reviewer:

1. Emits `finding { category: "review-scope-degraded", severity: "warning", file: <name>, message: "File exceeds single-call token budget; only the first N tokens were reviewed" }`.
2. Sets `partialReview: true` on the run artifact with `partialReviewReasons: ["oversized-files"]`.
3. Posts a distinct line on the PR review comment naming the skipped or truncated files.

Cost-aware behavior: when `cost.policy = stop-before-step`, an oversized file past token budget → `AutopilotError { code: 'budget_exceeded' }` before the per-file review call. Users then decide whether to split the PR or override the budget.

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

### 9.3 Retention & redaction

- `.claude/logs/` and `.claude/runs/` gitignored by default.
- `config.persistence.artifactRetentionDays` (default 30): cleanup job on every `autopilot` invocation removes artifacts older than the threshold.
- `config.persistence.persistRawPrompts` / `persistRawResponses` (default `false`): review-engine inputs/outputs persisted only as token counts + content hash + `finding[]`. No raw diff, no raw LLM response. Opt in if a user explicitly wants debugging visibility.
- `config.persistence.redactionPatterns`: every string written to NDJSON / run artifact / cache runs through the regex list and `[REDACTED:<pattern>]` replaces matches. Defaults cover `sk-`, `eyJ`, `ghp_`, `xoxb-`, `AKIA...`. Users add custom patterns.
- Cache skip-on-secret: pre-cache check runs redaction patterns against content; if any match, cache write is skipped + a `cache.skip-secret-detected` event is emitted.
- Users who want retention past the cleanup threshold ship artifacts to their own log aggregator via filesystem watcher or post-run hook (documented, not implemented in v1.0).

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

Total: 20 scenario tests.
```

### 10.4 Adapter conformance tests (new per G6)

Shared test suite each adapter runs through. Every built-in adapter must pass its interface's conformance suite. External adapters (in user repos) should too, using the exported suites.

```
tests/conformance/
├── review-engine.conformance.ts          5 tests × each ReviewEngine built-in (2 built-ins = 10 runs)
│   ├─ returns findings with required shape for canonical spec input
│   ├─ returns findings for canonical pr-diff input
│   ├─ estimateTokens within ±10% of actual usage
│   ├─ apiVersion matches core's expected major version
│   └─ getCapabilities returns sensible bounds (maxContextTokens > 0, etc.)
├── vcs-host.conformance.ts               5 tests × each VcsHost built-in (1 = 5 runs)
│   ├─ getPrDiff returns non-empty string for known fixture
│   ├─ createPr returns alreadyExisted=true on duplicate call with same idempotencyKey
│   ├─ postComment returns same commentId for duplicate idempotencyKey
│   ├─ getReviewComments returns shape with required fields
│   └─ apiVersion + getCapabilities conforms
├── migration-runner.conformance.ts       5 tests × each MigrationRunner built-in (5 = 25 runs)
│   ├─ discover returns candidate migrations from touched files
│   ├─ dryRun returns ok=true on valid migration
│   ├─ dryRun returns ok=false with errors on malformed migration
│   ├─ apply then alreadyApplied returns true
│   └─ ledger returns non-empty list after apply
└── review-bot-parser.conformance.ts      5 tests × each ReviewBotParser built-in (4 = 20 runs)
    ├─ detect returns true on canonical bot comment
    ├─ detect returns false on unrelated author
    ├─ fetchFindings parses known fixture into findings
    ├─ detectDismissal returns true on canonical dismissal phrase
    └─ apiVersion + getCapabilities conforms

Total: 60 conformance test runs (5 tests × 12 built-in adapters).
```

### 10.5 Safety tests (new per Codex C1/C2/C3 + W6)

```
tests/safety/
├── idempotency.test.ts                    4 tests
│   ├─ replay of completed run does not duplicate PR
│   ├─ replay of completed run does not re-apply migrations
│   ├─ replay of completed run does not duplicate comments
│   └─ resume from failed run picks up at failure step, not start
├── concurrency.test.ts                    3 tests
│   ├─ second run on same branch aborts with concurrency_lock (default)
│   ├─ cancel-existing policy terminates prior run + takes lock
│   └─ stale lock (PID not running) is reclaimed after grace period
├── redaction.test.ts                      3 tests
│   ├─ default redaction patterns mask sk-/eyJ/ghp_ in NDJSON
│   ├─ cache write skipped when content matches redaction pattern
│   └─ persistRawPrompts=false suppresses raw prompt content in artifacts
└── adapter-trust.test.ts                  3 tests
    ├─ config with non-allowlisted package rejects with pointed error
    ├─ relative path adapter missing required method fails fast at load
    └─ preflight warns when allowlisted package version is not pinned

Total: 13 safety tests.
```

**Grand total:** 20 scenario + 60 conformance + 13 safety = **93 tests**. Scale beyond the "15-20" floor user requested, but comfortably within a 4-5 second test suite on Node 22.

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

Each preset is a directory:

```
presets/nextjs-supabase/
├── autopilot.config.yaml       # defaults users inherit via `preset: nextjs-supabase`
├── stack.md                    # Codex system-prompt context
├── rules/                      # 1–3 invariant security rules per preset (see Codex feedback)
│   ├── supabase-rls-bypass.ts
│   └── weaviate-tenant-missing.ts
├── github-action.yml           # template for .github/workflows/autopilot.yml (per G2)
└── README.md                   # usage guide: what this preset assumes + required secrets + customization
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
- **v1.0.0-alpha.2** — all 4 adapters wired, all 5 presets, all 20 scenario tests
- **v1.0.0-alpha.3** — adapter conformance + safety tests passing (full 93-test suite)
- **v1.0.0-beta.1** — internal dogfooding on Delegance for 2 weeks (criteria below)
- **v1.0.0** — public npm publish

### 12.4 Beta exit criteria (new per G9)

Beta exits and v1.0.0 stable releases when ALL of the following hold across two consecutive weeks of dogfooding on the Delegance main repo:

| Metric | Target |
|---|---|
| Autopilot runs initiated | ≥10 |
| Runs that complete without human intervention | ≥80% (8 of 10) |
| Runs that introduce a false-positive CRITICAL finding | 0 |
| Runs with duplicate PR creation, migration re-application, or duplicate comments | 0 |
| p95 run latency (spec → merged PR, small PR) | ≤12 min |
| p95 review latency on `file-level` tier PRs | ≤6 min |
| Secret leak (any token, key, or PII observed in persisted artifact) | 0 |
| Adapter conformance tests passing on all built-ins | 100% |
| Config schema change | 0 (schema frozen during beta) |

Any failure below the target bumps a fix + restarts the two-week clock.

---

## 13. Safety & Trust Model

### 13.1 Idempotency & resumable runs (new in v1.0 per Codex C1)

Every pipeline step is idempotent. Side-effect steps (migrate, push, create-PR, post-comment) persist completion state and check "already applied" before re-executing.

**Run state file:** `.claude/runs/<run-id>/state.json`

```jsonc
{
  "runId": "2026-04-20-1432-topic",
  "topic": "claude-autopilot-v1",
  "startedAt": "...",
  "lastUpdatedAt": "...",
  "status": "in-progress",              // in-progress | completed | failed | superseded
  "currentStep": "review",
  "steps": {
    "plan":          { "status": "completed", "idempotencyKey": "...", "artifact": "docs/superpowers/plans/..." },
    "worktree":      { "status": "completed", "idempotencyKey": "...", "artifact": ".claude/worktrees/..." },
    "implement":     { "status": "completed", "idempotencyKey": "...", "lastCommitSha": "abc1234" },
    "migrate":       { "status": "completed", "idempotencyKey": "...", "appliedMigrations": ["20260420..."] },
    "validate":      { "status": "completed", "idempotencyKey": "..." },
    "push":          { "status": "completed", "idempotencyKey": "...", "pushedSha": "abc1234" },
    "create-pr":     { "status": "completed", "idempotencyKey": "...", "prNumber": 456, "alreadyExisted": false },
    "review":        { "status": "failed",    "idempotencyKey": "...", "errorCode": "rate_limit", "attempts": 2 },
    "bugbot":        { "status": "pending" }
  }
}
```

**Resume:** `npx autopilot run --resume=<run-id>` loads state and resumes at the first non-completed step. Each step's idempotency key is derived from `hash(runId, step, inputs)` and passed to adapters that accept it. Adapters check "already applied" by consulting the VCS/ledger/cache before executing.

**Idempotency guarantees:**

| Step | Mechanism |
|---|---|
| `migrate` | `alreadyApplied(migration, env)` check before `apply()` |
| `push` | `git fetch` + check if remote already at `lastCommitSha` |
| `create-pr` | `gh pr list --head=<branch>` check; `alreadyExisted: true` returned if match |
| `post-comment` / `reply-to-comment` | hash of `(body, target)` stored; fetch existing comments and skip if hash match |
| `review` | cache key check (if cache enabled) + response replay |

**Full rollback** (revert commits, rollback migrations) **is v1.1.** v1.0 ships idempotent resume only. Rationale: idempotent resume solves 90% of real failure cases without the complexity of reversing applied state.

### 13.2 Adapter trust model (new in v1.0 per Codex C2)

Adapters are high-privilege code running in a CI environment with access to VCS tokens, LLM API keys, and database credentials. Default posture is strict:

1. **Built-in adapters only by default.** `reviewEngine.adapter: codex` resolves to the bundled adapter module. No filesystem lookup.
2. **Relative paths must be explicit.** `./adapters/my-engine.ts` resolves relative to config file dir; adapter-loader imports and validates interface conformance at startup. Fails fast with pointed diagnostic if a method is missing or signature mismatches.
3. **Npm packages require allowlist.** `@delegance/autopilot-adapter-gitlab` is loaded ONLY if listed in `adapterAllowlist` config + present in `package.json` with a pinned version (not a range).
4. **No auto-resolution.** The `autopilot-adapter-*` naming convention is for **human discoverability only** — installers + README listings. The loader never enumerates `node_modules` looking for matching packages.
5. **Lockfile enforcement.** `preflight` warns if `package-lock.json` is missing or if allowlisted adapter versions aren't pinned in the lockfile.
6. **Provenance check (optional).** `adapterProvenance: strict` config flag requires allowlisted packages to be published with npm provenance. Fails fast if a version lacks provenance metadata.

### 13.3 Data classification & privacy (new in v1.0 per Codex C3)

See §9.3 for persistence controls. Summary:

- Raw prompts/responses/diffs **not persisted by default**. Opt in via `persistRawPrompts` / `persistRawResponses`.
- Redaction patterns applied to all persisted strings (NDJSON, run artifact, cache).
- Cache keys tenant-scoped: `hash(repoFullName, contentHash, engineName, adapterApiVersion, promptTemplateVersion, configHash)`. Never global.
- Cache write skipped if redaction pattern matches content.
- `cache.scope: disabled` fully opts out of caching.
- Artifact retention bounded by `artifactRetentionDays`.

### 13.4 Concurrency control (new in v1.0 per Codex W6)

- Run lock: `.claude/runs/.lock` keyed by `(repoFullName, branch)`. Written atomically via `fs.writeFileSync` with `wx` flag.
- `concurrency.onConflict: abort` (default): new run exits with `AutopilotError { code: 'concurrency_lock' }` and exit code 0 (CI-friendly).
- `concurrency.onConflict: cancel-existing`: new run sends SIGTERM to existing run PID (stored in lock file), waits up to 30s for graceful shutdown, then takes the lock. Existing run persists state with `status: superseded`.
- CI template uses `concurrency.cancel-in-progress: true` for matching PR head SHA.

### 13.5 Cost enforcement (new in v1.0 per Codex N8)

- `cost.perRunBudgetUSD` + `cost.monthlyBudgetUSD`: tracked via price table (built-in covers OpenAI + Anthropic current models; users extend via `priceTable` config).
- Policy modes:
  - `warn`: emit `cost.budget-exceeded` event; continue. User sees in run artifact.
  - `stop-before-step`: estimate next step's cost; if exceeding budget, throw `AutopilotError { code: 'budget_exceeded' }` BEFORE the step starts.
  - `stop-immediate`: budget check on every adapter call; throw immediately when budget would be exceeded (partial step results possible).
- Monthly budget tracked across runs via `.claude/cost-history.json` (rolling 31-day window).

---

## 14. CLI Surface

### 14.1 Subcommands

```
autopilot init                              # interactive: detect stack, pick preset, write config, setup env
autopilot preflight                         # prerequisite check (Node, gh, tsx, env, superpowers)
autopilot validate                          # pre-PR validation pipeline
autopilot validate-config [--check-adapters] # read-only: verify config + adapter resolution
autopilot validate-config --write-stub      # one-shot v0.1 → v1.0 migration helper
autopilot config migrate                    # upgrade configVersion (when introduced)
autopilot codex-pr-review <pr>              # review PR diff and post comment
autopilot bugbot [--pr=N]                   # triage review-bot comments
autopilot run [<spec-file>]                 # full pipeline from spec → PR → review (main /autopilot)
autopilot run --resume=<run-id>             # resume a failed run at the first non-completed step
autopilot install-github-action [preset]    # writes .github/workflows/autopilot.yml
autopilot cost report [--month]             # show cost history
```

### 14.2 `autopilot init` behavior (new per G1)

1. Detect stack by checking for marker files:
   - `package.json` + `next.config.*` + `@supabase/supabase-js` dep → suggest `nextjs-supabase`
   - `package.json` + `prisma/schema.prisma` + `next-auth` dep → suggest `t3`
   - `Gemfile` + `config/application.rb` → suggest `rails-postgres`
   - `pyproject.toml` + FastAPI in deps → suggest `python-fastapi`
   - `go.mod` → suggest `go`
   - Multiple matches or none → present full list
2. Prompt for confirmation + override if wanted.
3. Write `autopilot.config.yaml` with preset selected + stub `stack:` field pre-filled from detected stack.
4. Check for `.env` / `.env.local`; prompt for missing `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`; write to existing file or create `.env.example`.
5. Create `.claude/runs/` + `.claude/logs/` + `.gitignore` entries.
6. Print next-steps: run `autopilot preflight`, then `autopilot init` for a dry test.

Target: under 60 seconds from `npx autopilot init` to ready-to-run.

### 14.3 `autopilot install-github-action` behavior (new per G2)

Generates `.github/workflows/autopilot.yml` tailored to detected preset. Includes:

- Trigger: `pull_request`, `workflow_dispatch`
- Concurrency group: `${{ github.workflow }}-${{ github.head_ref }}` with `cancel-in-progress: true`
- Steps: checkout, setup-node, `npx autopilot preflight`, `npx autopilot validate`, `npx autopilot codex-pr-review ${{ github.event.pull_request.number }}`
- Secrets documented in comments at top: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, optionally stack-specific DB creds for migration dry-run
- Artifact upload: `.claude/runs/` and `.claude/logs/` uploaded as workflow artifacts for 7 days

Other CI providers documented in README (CircleCI, GitLab CI) but not auto-generated in v1.0.

### 14.4 Programmatic API (new per G3)

```typescript
// Exported from package root
import { runPipeline, validatePipeline, reviewPr, type AutopilotConfig } from '@delegance/claude-autopilot';

// Run the full pipeline programmatically (for IDE integrations, custom orchestrators)
const result = await runPipeline({ specFile: 'docs/.../spec.md', config: loadedConfig, resume: 'run-id-or-undefined' });

// Just validate (no PR side effects)
const report = await validatePipeline({ config: loadedConfig });

// Just review a PR
const review = await reviewPr({ pr: 123, config: loadedConfig });
```

All functions return typed results. Errors thrown are `AutopilotError` instances. Programmatic API is semver-stable: major bumps for signature changes.

### 14.5 Adapter discovery convention (new per G4)

- Community adapters **may** be published as `autopilot-adapter-<name>` npm packages by convention. This is for discoverability via npm search + README listings only.
- README lists known community adapters with a security disclaimer.
- Loader does NOT auto-resolve matching packages from `node_modules` — explicit `adapterAllowlist` + pinned versions required (§13.2).

---

## 15. Risks & Open Questions

### 15.1 Risks

| Risk | Mitigation |
|---|---|
| Adapter interface churn during alpha forces downstream rewrites | Alpha releases explicitly marked unstable; lock interfaces before beta; `apiVersion` major-version check enforces compatibility |
| `partialReview` flag is ignored by users → low-quality reviews ship | PR comment is prominent + verdict annotation + CI gate hint documented |
| Per-preset invariant rules drift from underlying stack conventions | Contributor guide requires each rule to cite the stack convention it enforces |
| NDJSON log size on long runs | Retention guide: rotate by run-id, gitignore by default, `artifactRetentionDays` auto-cleanup |
| `node:test` maturity for snapshot testing | We don't use snapshots; assertions are explicit. Reassess for v1.1 if needed |
| Resume state file corruption on partial write | Atomic writes via `writeFileSync` with temp-rename pattern; corrupt state file triggers fresh run + warning |
| Cache poisoning across configs that look equivalent | Cache key includes `configHash` + `promptTemplateVersion` + `adapterApiVersion` — prompt template or policy change invalidates |
| Idempotency keys collide on parallel runs | Lock prevents parallel runs on same `(repo, branch)`; idempotency scope is per-run |
| Budget runaway if price table is wrong for new model | `priceTable` is explicit; unknown model → cost calculation reports `unknown` and `stop-before-step` policy treats as budget-exceeded |
| CI users who forget to commit `autopilot.config.yaml` | Preflight fails with pointed diagnostic; CI template includes file-exists check |

### 15.2 Open questions

None blocking implementation. Documented decisions:

- **Package org:** `@delegance/claude-autopilot` (using existing npm token). Could be renamed later; CLI name `autopilot` stays the same.
- **Node minimum:** 22 (current), per existing preflight check.
- **License:** MIT (unchanged).
- **Usage telemetry:** none in v1.0. NDJSON logs are local-only. Opt-in usage telemetry is a v1.1 discussion.
- **Windows support:** Node 22 works on Windows, but `gh` CLI behavior + shell pipelines in adapters not tested on Windows in v1.0. Documented as "best effort."

---

## 16. Implementation Order (for writing-plans to consume)

1. **Core scaffolding** — `src/core/findings/types.ts`, `src/core/config/`, `src/core/logging/`, `src/core/errors.ts` (AutopilotError). Redaction helpers. No adapters yet.
2. **Interface definitions** — `src/adapters/*/types.ts` for all four integration points + `AdapterBase` + `Capabilities` + `apiVersion` handshake.
3. **Run-state machine** — `src/core/runtime/state.ts` (state.json persistence), `src/core/runtime/lock.ts` (concurrency), `src/core/runtime/idempotency.ts` (key derivation).
4. **Migrate current adapters** — port existing Codex, GitHub, Supabase, cursor-bot code behind new interfaces. Add `apiVersion`, `getCapabilities()`, idempotency support.
5. **Unified static-rules phase** — merge phase1+2+3 with global re-check; convert existing rules to `StaticRule` plugins.
6. **Chunking** — implement tier-selector, single-pass, file-level, `partialReview` annotation (run-level + file-level for oversized files per G7).
7. **NDJSON + run artifact** — wire into orchestrator and phases. Hook redaction pipeline.
8. **Cost tracking** — price table, per-adapter cost computation, budget enforcement modes.
9. **Cache layer** — content-hash keying with multi-dimension scope; secret-check before write.
10. **New review-engine adapter** — claude (Anthropic Messages API, extended thinking, structured output).
11. **New migration runners** — prisma, alembic, rails, golang-migrate.
12. **New review-bot parsers** — coderabbit, greptile, sourcery (declarative via base class).
13. **Presets** — 5 preset directories with `autopilot.config.yaml` + `stack.md` + invariant rules + per-preset GitHub Actions workflow template.
14. **CLI commands** — `init` (interactive onboarding), `install-github-action`, `config migrate`, `cost report`, `run --resume`, `validate-config`.
15. **Programmatic API exports** — `runPipeline`, `validatePipeline`, `reviewPr` from package root with full types.
16. **Test harness — scenario tests** (20 from §10.3).
17. **Test harness — adapter conformance tests** — shared suite for each of 4 interfaces; every built-in adapter passes the suite. ~20 tests (5 per interface × 4 interfaces, with shared fixtures).
18. **Test harness — safety tests** — idempotency (replay doesn't duplicate side effects), concurrency (lock prevents overlap), redaction (secrets don't land in artifacts), resume (failed run resumes cleanly).
19. **Skill updates** — rewrite `.claude/skills/autopilot/SKILL.md` to delegate to new CLI, reflect resume semantics.
20. **Dogfood + beta** — see §12.3 exit criteria.
21. **Release** — npm publish v1.0.0, README rewrite, announce.
