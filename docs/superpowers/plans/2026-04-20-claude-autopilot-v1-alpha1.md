# claude-autopilot v1.0.0-alpha.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the v1.0 architecture, define the four integration-point interfaces, port existing adapters behind the new interfaces, ship the unified static-rules phase, and land 1 preset (nextjs-supabase) with 5 foundational tests. Produces a working but alpha-quality autopilot that runs against the Delegance repo.

**Architecture:** Reorganize `scripts/` into `src/core/` (pipeline-agnostic) + `src/adapters/` (swappable integrations). All adapters implement a shared `AdapterBase` with `apiVersion` + `getCapabilities()`. Findings become a single shared type across validate + review-bot with split history (`TriageRecord[]`, `FixAttempt[]`). Runtime state machine (state.json + lock file + idempotency keys) exists but stubbed — full safety semantics land in alpha.3. Static-rules phase merges phase 1/2/3 with a global re-check after autofix.

**Tech Stack:** TypeScript 5.x, Node 22 native (`node:test`, `node:fs`, `node:crypto`), `tsx` loader, npm, YAML config (`js-yaml`), JSON Schema (`ajv`).

**Shell helper:** All adapter-level process invocation goes through `src/core/shell.ts` (created in Task 1.5), which wraps the Node runner in a typed, error-aware helper. Adapters never touch the raw runner directly.

---

## File Structure (alpha.1)

```
claude-autopilot/
├── src/
│   ├── core/
│   │   ├── shell.ts                           # typed wrapper around process runner (no direct exec anywhere else)
│   │   ├── errors.ts                          # AutopilotError + codes
│   │   ├── findings/
│   │   │   ├── types.ts                       # Finding, TriageRecord, FixAttempt
│   │   │   └── dedup.ts
│   │   ├── config/
│   │   │   ├── types.ts
│   │   │   ├── schema.ts
│   │   │   ├── loader.ts
│   │   │   └── preset-resolver.ts
│   │   ├── logging/
│   │   │   ├── ndjson-writer.ts
│   │   │   └── redaction.ts
│   │   ├── runtime/
│   │   │   ├── state.ts
│   │   │   ├── lock.ts
│   │   │   └── idempotency.ts
│   │   └── phases/
│   │       └── static-rules.ts
│   ├── adapters/
│   │   ├── base.ts
│   │   ├── loader.ts
│   │   ├── review-engine/{types.ts, codex.ts}
│   │   ├── vcs-host/{types.ts, github.ts}
│   │   ├── migration-runner/{types.ts, supabase.ts}
│   │   └── review-bot-parser/{types.ts, declarative-base.ts, cursor.ts}
│   └── cli/
│       └── preflight.ts
├── presets/
│   └── nextjs-supabase/{autopilot.config.yaml, stack.md, rules/supabase-rls-bypass.ts}
├── tests/
│   ├── fixtures/{configs/, adapters/}
│   ├── errors.test.ts
│   ├── findings-dedup.test.ts                 # TEST 2 (foundational)
│   ├── adapter-base.test.ts
│   ├── config-loader.test.ts                  # TEST 1 (foundational)
│   ├── preset-resolver.test.ts
│   ├── redaction.test.ts
│   ├── ndjson-logger.test.ts
│   ├── runtime-state.test.ts                  # TEST 3 (foundational)
│   ├── adapter-loader.test.ts                 # TEST 4 (foundational)
│   └── static-rules-phase.test.ts             # TEST 5 (foundational)
├── tsconfig.json
├── package.json
└── .gitignore
```

**Non-goals for alpha.1:**
- Chunking tiers (alpha.2)
- Cost / cache / persistence config (alpha.2)
- Full NDJSON event wiring through phases (alpha.2)
- Full safety model (alpha.3)
- 5 presets (alpha.2; alpha.1 ships only nextjs-supabase)
- Conformance + safety tests (alpha.3)
- CLI subcommands beyond preflight (alpha.4)
- Programmatic API exports (alpha.4)

---

## Task 1: Setup — tsconfig, package.json, deps

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "rootDir": ".",
    "outDir": "./dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "presets/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Update `package.json`**

```json
{
  "name": "@delegance/claude-autopilot",
  "version": "1.0.0-alpha.1",
  "private": true,
  "type": "module",
  "description": "Claude Code pipeline: spec to PR with review",
  "bin": { "autopilot": "./src/cli/preflight.ts" },
  "scripts": {
    "test": "node --test --import tsx tests/**/*.test.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc"
  },
  "devDependencies": {
    "@types/js-yaml": "^4",
    "@types/node": "^22",
    "ajv": "^8",
    "dotenv": ">=16",
    "js-yaml": "^4",
    "minimatch": ">=9",
    "openai": ">=4",
    "tsx": ">=4",
    "typescript": "^5"
  }
}
```

- [ ] **Step 3: Update `.gitignore`**

```
node_modules/
dist/
.claude/runs/
.claude/logs/
.claude/.lock
*.log
.env
.env.local
```

- [ ] **Step 4: Install + typecheck**

```bash
npm install
mkdir -p src/core && touch src/core/.gitkeep
npx tsc --noEmit
```

Expected: exit 0, clean install.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json package.json package-lock.json .gitignore src/core/.gitkeep
git commit -m "chore: v1.0.0-alpha.1 scaffold — tsconfig, package.json, deps"
```

---

## Task 2: Shell helper (safe process runner wrapper)

**Files:**
- Create: `src/core/shell.ts`
- Test: `tests/shell.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/shell.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSafe, runThrowing } from '../src/core/shell.ts';
import { AutopilotError } from '../src/core/errors.ts';

test('runSafe returns stdout on success', () => {
  const out = runSafe('node', ['-e', 'process.stdout.write("ok")']);
  assert.equal(out, 'ok');
});

test('runSafe returns null on non-zero exit', () => {
  const out = runSafe('node', ['-e', 'process.exit(1)']);
  assert.equal(out, null);
});

test('runThrowing throws AutopilotError on non-zero exit', () => {
  assert.throws(
    () => runThrowing('node', ['-e', 'process.exit(2)']),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'transient_network');
      return true;
    }
  );
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx tsx --test tests/shell.test.ts`
Expected: FAIL (shell.ts missing)

- [ ] **Step 3: Create `src/core/shell.ts`**

```typescript
// src/core/shell.ts

import { execFileSync } from 'node:child_process';
import { AutopilotError, type ErrorCode } from './errors.ts';

export interface RunOptions {
  timeout?: number;
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Run a command; return stdout on success, null on any failure. Never throws. */
export function runSafe(cmd: string, args: string[], options: RunOptions = {}): string | null {
  try {
    const result = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 60000,
      input: options.input,
      cwd: options.cwd,
      env: options.env,
    });
    return result.toString();
  } catch {
    return null;
  }
}

/** Run a command; throw AutopilotError on failure. */
export function runThrowing(cmd: string, args: string[], options: RunOptions & { errorCode?: ErrorCode; provider?: string } = {}): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 60000,
      input: options.input,
      cwd: options.cwd,
      env: options.env,
    }).toString();
  } catch (err) {
    throw new AutopilotError(`Command failed: ${cmd} ${args.join(' ')}`, {
      code: options.errorCode ?? 'transient_network',
      provider: options.provider,
      details: { cmd, args, cause: err instanceof Error ? err.message : String(err) },
    });
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx tsx --test tests/shell.test.ts`
Expected: all 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/core/shell.ts tests/shell.test.ts
git commit -m "feat(core): shell helper (runSafe / runThrowing) wraps process runner with typed errors"
```

---

## Task 3: Core error taxonomy

**Files:**
- Create: `src/core/errors.ts`
- Test: `tests/errors.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/errors.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutopilotError, type ErrorCode } from '../src/core/errors.ts';

test('AutopilotError preserves code, retryable, provider, step, details', () => {
  const err = new AutopilotError('rate limit hit', {
    code: 'rate_limit',
    retryable: true,
    provider: 'codex',
    step: 'review',
    details: { retryAfter: 30 },
  });
  assert.equal(err.message, 'rate limit hit');
  assert.equal(err.code, 'rate_limit');
  assert.equal(err.retryable, true);
  assert.equal(err.provider, 'codex');
  assert.equal(err.step, 'review');
  assert.deepEqual(err.details, { retryAfter: 30 });
  assert.ok(err instanceof Error);
});

test('AutopilotError defaults retryable from code', () => {
  const nonRetryable: ErrorCode[] = ['auth', 'invalid_config', 'adapter_bug', 'user_input', 'budget_exceeded', 'concurrency_lock', 'superseded'];
  for (const code of nonRetryable) {
    const e = new AutopilotError('x', { code });
    assert.equal(e.retryable, false);
  }
  const retryable: ErrorCode[] = ['rate_limit', 'transient_network'];
  for (const code of retryable) {
    const e = new AutopilotError('x', { code });
    assert.equal(e.retryable, true);
  }
});
```

- [ ] **Step 2: Create `src/core/errors.ts`**

```typescript
// src/core/errors.ts

export type ErrorCode =
  | 'auth' | 'rate_limit' | 'transient_network' | 'invalid_config'
  | 'adapter_bug' | 'user_input' | 'budget_exceeded' | 'concurrency_lock' | 'superseded';

export interface AutopilotErrorOptions {
  code: ErrorCode;
  retryable?: boolean;
  provider?: string;
  step?: string;
  details?: Record<string, unknown>;
}

const DEFAULT_RETRYABLE: Record<ErrorCode, boolean> = {
  auth: false, rate_limit: true, transient_network: true, invalid_config: false,
  adapter_bug: false, user_input: false, budget_exceeded: false,
  concurrency_lock: false, superseded: false,
};

export class AutopilotError extends Error {
  code: ErrorCode;
  retryable: boolean;
  provider?: string;
  step?: string;
  details: Record<string, unknown>;

  constructor(message: string, options: AutopilotErrorOptions) {
    super(message);
    this.name = 'AutopilotError';
    this.code = options.code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[options.code];
    this.provider = options.provider;
    this.step = options.step;
    this.details = options.details ?? {};
  }
}
```

- [ ] **Step 3: Run test — expect PASS**

Run: `npx tsx --test tests/errors.test.ts`
Expected: all 2 tests pass

- [ ] **Step 4: Commit**

```bash
git add src/core/errors.ts tests/errors.test.ts
git commit -m "feat(core): AutopilotError taxonomy with per-code retry defaults"
```

---

## Task 4: Findings types + dedup (TEST 2)

**Files:**
- Create: `src/core/findings/types.ts`
- Create: `src/core/findings/dedup.ts`
- Test: `tests/findings-dedup.test.ts` (foundational TEST 2)

- [ ] **Step 1: Write failing test**

```typescript
// tests/findings-dedup.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Finding } from '../src/core/findings/types.ts';
import { dedupFindings } from '../src/core/findings/dedup.ts';

function f(p: Partial<Finding>): Finding {
  return {
    id: 'tmp', source: 'static-rules', severity: 'warning', category: 'test',
    file: 'src/x.ts', message: 'msg', protectedPath: false,
    createdAt: '2026-04-20T00:00:00.000Z', ...p,
  };
}

test('dedupFindings removes exact duplicates on (file, line, severity, msg-head)', () => {
  const a = f({ id: 'a', file: 'src/x.ts', line: 10, severity: 'critical', message: 'leaked key' });
  const b = f({ id: 'b', file: 'src/x.ts', line: 10, severity: 'critical', message: 'leaked key' });
  const c = f({ id: 'c', file: 'src/y.ts', line: 10, severity: 'critical', message: 'leaked key' });
  const result = dedupFindings([a, b, c]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(r => r.id).sort(), ['a', 'c']);
});

test('dedupFindings treats different severity as different', () => {
  const a = f({ id: 'a', severity: 'warning', message: 'same msg' });
  const b = f({ id: 'b', severity: 'critical', message: 'same msg' });
  assert.equal(dedupFindings([a, b]).length, 2);
});

test('dedupFindings uses first 40 chars of message as dedup key', () => {
  const a = f({ id: 'a', message: 'X'.repeat(40) + ' suffix A' });
  const b = f({ id: 'b', message: 'X'.repeat(40) + ' suffix B' });
  assert.equal(dedupFindings([a, b]).length, 1);
});
```

- [ ] **Step 2: Create `src/core/findings/types.ts`**

```typescript
// src/core/findings/types.ts

export type FindingSource = 'static-rules' | 'review-engine' | `review-bot:${string}`;
export type Severity = 'critical' | 'warning' | 'note';

export interface Finding {
  id: string;
  source: FindingSource;
  severity: Severity;
  category: string;
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  protectedPath: boolean;
  createdAt: string;
}

export type TriageVerdict = 'real_bug' | 'false_positive' | 'low_value';
export type TriageAction = 'auto_fix' | 'propose_patch' | 'ask_question' | 'dismiss' | 'needs_human';

export interface TriageRecord {
  findingId: string;
  verdict: TriageVerdict;
  confidence: number;
  reason: string;
  action: TriageAction;
  recordedAt: string;
}

export type FixStatus = 'fixed' | 'reverted' | 'human_required' | 'skipped';

export interface FixAttempt {
  findingId: string;
  attemptedAt: string;
  status: FixStatus;
  commitSha?: string;
  notes?: string;
}
```

- [ ] **Step 3: Create `src/core/findings/dedup.ts`**

```typescript
// src/core/findings/dedup.ts

import type { Finding } from './types.ts';

function dedupKey(f: Finding): string {
  return `${f.file}|${f.line ?? ''}|${f.severity}|${f.message.slice(0, 40)}`;
}

export function dedupFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = dedupKey(f);
    if (!seen.has(key)) seen.set(key, f);
  }
  return Array.from(seen.values());
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx tsx --test tests/findings-dedup.test.ts`
Expected: all 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/core/findings tests/findings-dedup.test.ts
git commit -m "feat(core): Finding types + dedupFindings (first-wins dedup)"
```

---

## Task 5: AdapterBase + Capabilities

**Files:**
- Create: `src/adapters/base.ts`
- Test: `tests/adapter-base.test.ts`

- [ ] **Step 1: Create `src/adapters/base.ts`**

```typescript
// src/adapters/base.ts

export interface AdapterBase {
  name: string;
  apiVersion: string;
  getCapabilities(): Capabilities;
}

export interface Capabilities {
  [feature: string]: boolean | number | string;
}

export const CORE_ADAPTER_API_VERSION_MAJOR = 1;

export function checkApiVersionCompatibility(adapterApiVersion: string): boolean {
  const parts = adapterApiVersion.split('.');
  const major = parseInt(parts[0] ?? '0', 10);
  return major === CORE_ADAPTER_API_VERSION_MAJOR;
}
```

- [ ] **Step 2: Write + run test**

```typescript
// tests/adapter-base.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkApiVersionCompatibility } from '../src/adapters/base.ts';

test('checkApiVersionCompatibility accepts matching major', () => {
  assert.equal(checkApiVersionCompatibility('1.0.0'), true);
  assert.equal(checkApiVersionCompatibility('1.5.2'), true);
});

test('checkApiVersionCompatibility rejects mismatched major', () => {
  assert.equal(checkApiVersionCompatibility('0.9.0'), false);
  assert.equal(checkApiVersionCompatibility('2.0.0'), false);
});
```

Run: `npx tsx --test tests/adapter-base.test.ts`
Expected: all 2 tests pass

- [ ] **Step 3: Commit**

```bash
git add src/adapters/base.ts tests/adapter-base.test.ts
git commit -m "feat(adapters): AdapterBase + apiVersion compat check"
```

---

## Task 6: Integration-point interface types

**Files:**
- Create: `src/adapters/review-engine/types.ts`
- Create: `src/adapters/vcs-host/types.ts`
- Create: `src/adapters/migration-runner/types.ts`
- Create: `src/adapters/review-bot-parser/types.ts`

- [ ] **Step 1: Create review-engine types**

```typescript
// src/adapters/review-engine/types.ts

import type { AdapterBase } from '../base.ts';
import type { Finding } from '../../core/findings/types.ts';

export interface ReviewInput {
  content: string;
  kind: 'spec' | 'pr-diff' | 'file-batch';
  context?: { spec?: string; plan?: string; stack?: string };
}

export interface ReviewOutput {
  findings: Finding[];
  rawOutput: string;
  usage?: { input: number; output: number; costUSD?: number };
}

export interface ReviewEngine extends AdapterBase {
  review(input: ReviewInput): Promise<ReviewOutput>;
  estimateTokens(content: string): number;
}
```

- [ ] **Step 2: Create vcs-host types**

```typescript
// src/adapters/vcs-host/types.ts

import type { AdapterBase } from '../base.ts';

export interface GenericComment {
  id: string | number;
  author: string;
  body: string;
  path?: string;
  line?: number;
  url?: string;
}

export interface PrMetadata {
  title: string;
  body: string;
  files: string[];
  headSha: string;
  baseRef: string;
  headRef: string;
}

export interface CreatePrOptions {
  title: string;
  body: string;
  base: string;
  head: string;
  draft?: boolean;
  idempotencyKey?: string;
}

export interface CreatePrResult {
  number: number;
  url: string;
  alreadyExisted: boolean;
}

export interface VcsHost extends AdapterBase {
  getPrDiff(pr: number | string): Promise<string>;
  getPrMetadata(pr: number | string): Promise<PrMetadata>;
  postComment(pr: number | string, body: string, idempotencyKey?: string): Promise<void>;
  getReviewComments(pr: number | string): Promise<GenericComment[]>;
  replyToComment(pr: number | string, commentId: string | number, body: string, idempotencyKey?: string): Promise<void>;
  createPr(opts: CreatePrOptions): Promise<CreatePrResult>;
  push(branch: string, opts?: { setUpstream?: boolean }): Promise<void>;
}
```

- [ ] **Step 3: Create migration-runner types**

```typescript
// src/adapters/migration-runner/types.ts

import type { AdapterBase } from '../base.ts';

export type MigrationEnv = 'dev' | 'qa' | 'prod';

export interface Migration {
  name: string;
  path: string;
  content?: string;
}

export interface DryRunResult {
  ok: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface ApplyResult {
  ok: boolean;
  appliedSha?: string;
  durationMs?: number;
  errors?: string[];
}

export interface LedgerEntry {
  name: string;
  appliedAt: string;
  sha?: string;
}

export interface MigrationRunner extends AdapterBase {
  discover(touchedFiles: string[]): Migration[];
  dryRun(migration: Migration): Promise<DryRunResult>;
  apply(migration: Migration, env: MigrationEnv): Promise<ApplyResult>;
  ledger(env: MigrationEnv): Promise<LedgerEntry[]>;
  alreadyApplied(migration: Migration, env: MigrationEnv): Promise<boolean>;
}
```

- [ ] **Step 4: Create review-bot-parser types**

```typescript
// src/adapters/review-bot-parser/types.ts

import type { AdapterBase } from '../base.ts';
import type { Finding } from '../../core/findings/types.ts';
import type { GenericComment, VcsHost } from '../vcs-host/types.ts';

export interface ReviewBotParser extends AdapterBase {
  detect(comment: GenericComment): boolean;
  fetchFindings(vcs: VcsHost, pr: number | string): Promise<Finding[]>;
  detectDismissal(reply: string): boolean;
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: exit 0

```bash
git add src/adapters/*/types.ts
git commit -m "feat(adapters): define all four integration-point interfaces"
```

---

## Task 7: Config types + JSON Schema

**Files:**
- Create: `src/core/config/types.ts`
- Create: `src/core/config/schema.ts`

- [ ] **Step 1: Create `src/core/config/types.ts`**

```typescript
// src/core/config/types.ts

export interface AdapterReference {
  adapter: string;
  options?: Record<string, unknown>;
}

export type AdapterRef = string | AdapterReference;

export type StaticRuleReference = string | { adapter: string; options?: Record<string, unknown> };

export interface AutopilotConfig {
  configVersion: 1;
  preset?: string;
  reviewEngine?: AdapterRef;
  vcsHost?: AdapterRef;
  migrationRunner?: AdapterRef;
  reviewBot?: AdapterRef;
  adapterAllowlist?: string[];
  protectedPaths?: string[];
  staticRules?: StaticRuleReference[];
  stack?: string;
  thresholds?: {
    bugbotAutoFix?: number;
    bugbotProposePatch?: number;
    maxValidateRetries?: number;
    maxCodexRetries?: number;
    maxBugbotRounds?: number;
  };
  reviewStrategy?: 'auto' | 'single-pass' | 'file-level';
  chunking?: {
    smallTierMaxTokens?: number;
    partialReviewTokens?: number;
    perFileMaxTokens?: number;
  };
  cost?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  persistence?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
}
```

- [ ] **Step 2: Create `src/core/config/schema.ts`**

```typescript
// src/core/config/schema.ts

export const AUTOPILOT_CONFIG_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['configVersion'],
  additionalProperties: false,
  properties: {
    configVersion: { const: 1 },
    preset: { type: 'string' },
    reviewEngine: { $ref: '#/definitions/adapterRef' },
    vcsHost: { $ref: '#/definitions/adapterRef' },
    migrationRunner: { $ref: '#/definitions/adapterRef' },
    reviewBot: { $ref: '#/definitions/adapterRef' },
    adapterAllowlist: { type: 'array', items: { type: 'string' } },
    protectedPaths: { type: 'array', items: { type: 'string' } },
    staticRules: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          { type: 'object', required: ['adapter'], properties: { adapter: { type: 'string' }, options: { type: 'object' } } },
        ],
      },
    },
    stack: { type: 'string' },
    thresholds: {
      type: 'object',
      properties: {
        bugbotAutoFix: { type: 'number' },
        bugbotProposePatch: { type: 'number' },
        maxValidateRetries: { type: 'number' },
        maxCodexRetries: { type: 'number' },
        maxBugbotRounds: { type: 'number' },
      },
      additionalProperties: false,
    },
    reviewStrategy: { enum: ['auto', 'single-pass', 'file-level'] },
    chunking: {
      type: 'object',
      properties: {
        smallTierMaxTokens: { type: 'number' },
        partialReviewTokens: { type: 'number' },
        perFileMaxTokens: { type: 'number' },
      },
      additionalProperties: false,
    },
    cost: { type: 'object' },
    cache: { type: 'object' },
    persistence: { type: 'object' },
    concurrency: { type: 'object' },
  },
  definitions: {
    adapterRef: {
      oneOf: [
        { type: 'string' },
        { type: 'object', required: ['adapter'], properties: { adapter: { type: 'string' }, options: { type: 'object' } } },
      ],
    },
  },
} as const;
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: exit 0

```bash
git add src/core/config/types.ts src/core/config/schema.ts
git commit -m "feat(config): AutopilotConfig types + JSON Schema"
```

---

## Task 8: Config loader (TEST 1)

**Files:**
- Create: `src/core/config/loader.ts`
- Create: `tests/fixtures/configs/valid-nextjs-supabase.yaml`
- Create: `tests/fixtures/configs/invalid-missing-required.yaml`
- Test: `tests/config-loader.test.ts` (foundational TEST 1)

- [ ] **Step 1: Create fixtures**

```yaml
# tests/fixtures/configs/valid-nextjs-supabase.yaml
configVersion: 1
preset: nextjs-supabase
reviewEngine:
  adapter: codex
vcsHost:
  adapter: github
thresholds:
  bugbotAutoFix: 85
chunking:
  smallTierMaxTokens: 8000
```

```yaml
# tests/fixtures/configs/invalid-missing-required.yaml
preset: nextjs-supabase
```

- [ ] **Step 2: Write test**

```typescript
// tests/config-loader.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/core/config/loader.ts';
import { AutopilotError } from '../src/core/errors.ts';

test('loadConfig parses valid YAML', async () => {
  const config = await loadConfig('tests/fixtures/configs/valid-nextjs-supabase.yaml');
  assert.equal(config.configVersion, 1);
  assert.equal(config.preset, 'nextjs-supabase');
  assert.equal(config.thresholds?.bugbotAutoFix, 85);
});

test('loadConfig rejects missing configVersion', async () => {
  await assert.rejects(
    () => loadConfig('tests/fixtures/configs/invalid-missing-required.yaml'),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'invalid_config');
      return true;
    }
  );
});

test('loadConfig throws user_input on missing file', async () => {
  await assert.rejects(
    () => loadConfig('tests/fixtures/configs/does-not-exist.yaml'),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'user_input');
      return true;
    }
  );
});
```

- [ ] **Step 3: Create `src/core/config/loader.ts`**

```typescript
// src/core/config/loader.ts

import * as fs from 'node:fs/promises';
import * as yaml from 'js-yaml';
import Ajv from 'ajv';
import { AutopilotError } from '../errors.ts';
import type { AutopilotConfig } from './types.ts';
import { AUTOPILOT_CONFIG_SCHEMA } from './schema.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(AUTOPILOT_CONFIG_SCHEMA);

export async function loadConfig(path: string): Promise<AutopilotConfig> {
  let content: string;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new AutopilotError(`Config file not found: ${path}`, {
      code: 'user_input',
      details: { path, cause: err instanceof Error ? err.message : String(err) },
    });
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new AutopilotError(`Invalid YAML in ${path}`, {
      code: 'invalid_config',
      details: { path, cause: err instanceof Error ? err.message : String(err) },
    });
  }

  if (!validate(parsed)) {
    const errors = (validate.errors ?? []).map(e => `${e.instancePath || '<root>'}: ${e.message}`);
    throw new AutopilotError('Config schema validation failed', {
      code: 'invalid_config',
      details: { path, errors },
    });
  }

  return parsed as AutopilotConfig;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx tsx --test tests/config-loader.test.ts`
Expected: all 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/core/config/loader.ts tests/fixtures/configs tests/config-loader.test.ts
git commit -m "feat(config): loadConfig with YAML parse + AJV schema validation"
```

---

## Task 9: Preset resolver

**Files:**
- Create: `src/core/config/preset-resolver.ts`
- Test: `tests/preset-resolver.test.ts`

- [ ] **Step 1: Create `src/core/config/preset-resolver.ts`**

```typescript
// src/core/config/preset-resolver.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadConfig } from './loader.ts';
import { AutopilotError } from '../errors.ts';
import type { AutopilotConfig } from './types.ts';

const PRESET_ROOT = path.resolve(process.cwd(), 'presets');

export interface ResolvedPreset {
  name: string;
  config: AutopilotConfig;
  stack: string;
}

export async function resolvePreset(name: string): Promise<ResolvedPreset> {
  const presetDir = path.join(PRESET_ROOT, name);
  try {
    await fs.stat(presetDir);
  } catch {
    throw new AutopilotError(`Preset not found: ${name}`, {
      code: 'invalid_config',
      details: { name, presetDir },
    });
  }

  const config = await loadConfig(path.join(presetDir, 'autopilot.config.yaml'));
  let stack = '';
  try {
    stack = await fs.readFile(path.join(presetDir, 'stack.md'), 'utf8');
  } catch {
    stack = config.stack ?? '';
  }
  return { name, config, stack };
}

export function mergeConfigs(preset: AutopilotConfig, user: AutopilotConfig): AutopilotConfig {
  return {
    ...preset,
    ...user,
    thresholds: { ...preset.thresholds, ...user.thresholds },
    chunking: { ...preset.chunking, ...user.chunking },
  };
}
```

- [ ] **Step 2: Write test**

```typescript
// tests/preset-resolver.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreset } from '../src/core/config/preset-resolver.ts';
import { AutopilotError } from '../src/core/errors.ts';

test('resolvePreset throws for unknown preset', async () => {
  await assert.rejects(
    () => resolvePreset('does-not-exist'),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'invalid_config');
      return true;
    }
  );
});

test('resolvePreset loads nextjs-supabase', { skip: 'un-skip after Task 15 creates preset' }, async () => {
  const preset = await resolvePreset('nextjs-supabase');
  assert.equal(preset.config.configVersion, 1);
  assert.ok(preset.stack.length > 0);
});
```

Run: `npx tsx --test tests/preset-resolver.test.ts`
Expected: 1 pass, 1 skipped

- [ ] **Step 3: Commit**

```bash
git add src/core/config/preset-resolver.ts tests/preset-resolver.test.ts
git commit -m "feat(config): resolvePreset + mergeConfigs (user over preset, arrays replaced)"
```

---

## Task 10: Redaction + NDJSON logger

**Files:**
- Create: `src/core/logging/redaction.ts`
- Create: `src/core/logging/ndjson-writer.ts`
- Test: `tests/redaction.test.ts`
- Test: `tests/ndjson-logger.test.ts`

- [ ] **Step 1: Write redaction test**

```typescript
// tests/redaction.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRedaction, DEFAULT_REDACTION_PATTERNS } from '../src/core/logging/redaction.ts';

test('applyRedaction masks OpenAI keys', () => {
  const out = applyRedaction('key=sk-abcdefghijklmnopqrstuvwxyz1234567890', DEFAULT_REDACTION_PATTERNS);
  assert.ok(!out.includes('sk-abc'));
  assert.ok(out.includes('[REDACTED]'));
});

test('applyRedaction leaves clean content alone', () => {
  const out = applyRedaction('hello world', DEFAULT_REDACTION_PATTERNS);
  assert.equal(out, 'hello world');
});

test('applyRedaction accepts custom patterns', () => {
  const out = applyRedaction('custom-secret-XYZ', ['custom-secret-[A-Z]+']);
  assert.ok(!out.includes('XYZ'));
});
```

- [ ] **Step 2: Create `src/core/logging/redaction.ts`**

```typescript
// src/core/logging/redaction.ts

export const DEFAULT_REDACTION_PATTERNS: readonly string[] = Object.freeze([
  'sk-[a-zA-Z0-9]{20,}',
  'eyJ[a-zA-Z0-9_-]{30,}',
  'ghp_[a-zA-Z0-9]{30,}',
  'xoxb-[a-zA-Z0-9-]{20,}',
  'AKIA[A-Z0-9]{16}',
]);

export function applyRedaction(text: string, patterns: readonly string[]): string {
  let result = text;
  for (const pattern of patterns) {
    result = result.replace(new RegExp(pattern, 'g'), '[REDACTED]');
  }
  return result;
}

export function containsSecret(text: string, patterns: readonly string[]): boolean {
  return patterns.some(p => new RegExp(p).test(text));
}
```

- [ ] **Step 3: Run redaction test — expect PASS**

Run: `npx tsx --test tests/redaction.test.ts`
Expected: 3 pass

- [ ] **Step 4: Create `src/core/logging/ndjson-writer.ts`**

```typescript
// src/core/logging/ndjson-writer.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyRedaction, DEFAULT_REDACTION_PATTERNS } from './redaction.ts';

export interface NdjsonLoggerOptions {
  runId: string;
  logsDir?: string;
  redactionPatterns?: readonly string[];
}

export class NdjsonLogger {
  private readonly runId: string;
  private readonly filePath: string;
  private readonly stream: fs.WriteStream;
  private readonly redactionPatterns: readonly string[];

  constructor(options: NdjsonLoggerOptions) {
    this.runId = options.runId;
    this.redactionPatterns = options.redactionPatterns ?? DEFAULT_REDACTION_PATTERNS;
    const logsDir = options.logsDir ?? path.join('.claude', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    this.filePath = path.join(logsDir, `${this.runId}.ndjson`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  log(event: string, fields: Record<string, unknown> = {}): void {
    const entry = { ts: new Date().toISOString(), runId: this.runId, event, ...fields };
    const serialized = applyRedaction(JSON.stringify(entry), this.redactionPatterns);
    this.stream.write(serialized + '\n');
  }

  close(): Promise<void> {
    return new Promise(resolve => this.stream.end(() => resolve()));
  }

  getFilePath(): string { return this.filePath; }
}
```

- [ ] **Step 5: Write logger integration test**

```typescript
// tests/ndjson-logger.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { NdjsonLogger } from '../src/core/logging/ndjson-writer.ts';

test('NdjsonLogger writes events + redacts secrets', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-log-'));
  const logger = new NdjsonLogger({ runId: 'r1', logsDir: tmpDir });
  logger.log('pipeline.start', { topic: 'x' });
  logger.log('adapter.call', { apiKey: 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  await logger.close();

  const contents = await fs.readFile(path.join(tmpDir, 'r1.ndjson'), 'utf8');
  const lines = contents.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).event, 'pipeline.start');
  assert.ok(!contents.includes('sk-aaa'));

  await fs.rm(tmpDir, { recursive: true, force: true });
});
```

Run: `npx tsx --test tests/ndjson-logger.test.ts`
Expected: 1 test pass

- [ ] **Step 6: Commit**

```bash
git add src/core/logging tests/redaction.test.ts tests/ndjson-logger.test.ts
git commit -m "feat(logging): NdjsonLogger + redaction for secret-safe event logging"
```

---

## Task 11: Runtime state machine (TEST 3)

**Files:**
- Create: `src/core/runtime/state.ts`
- Create: `src/core/runtime/lock.ts`
- Create: `src/core/runtime/idempotency.ts`
- Test: `tests/runtime-state.test.ts` (foundational TEST 3)

- [ ] **Step 1: Create `src/core/runtime/state.ts`**

```typescript
// src/core/runtime/state.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AutopilotError } from '../errors.ts';

export type PipelineStep =
  | 'plan' | 'worktree' | 'implement' | 'migrate' | 'validate'
  | 'push' | 'create-pr' | 'review' | 'bugbot';

export type StepStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';
export type RunStatus = 'in-progress' | 'completed' | 'failed' | 'superseded';

export interface StepState {
  status: StepStatus;
  idempotencyKey?: string;
  artifact?: string;
  errorCode?: string;
  attempts?: number;
  lastCommitSha?: string;
  appliedMigrations?: string[];
  prNumber?: number;
  alreadyExisted?: boolean;
}

export interface RunState {
  runId: string;
  topic: string;
  startedAt: string;
  lastUpdatedAt: string;
  status: RunStatus;
  currentStep: PipelineStep | null;
  steps: Record<PipelineStep, StepState>;
}

export const ALL_STEPS: readonly PipelineStep[] = Object.freeze([
  'plan', 'worktree', 'implement', 'migrate', 'validate', 'push', 'create-pr', 'review', 'bugbot',
]);

function stateFile(runId: string, runsDir: string): string {
  return path.join(runsDir, runId, 'state.json');
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

export interface CreateRunStateOptions {
  runId: string;
  topic: string;
  runsDir?: string;
}

export async function createRunState(options: CreateRunStateOptions): Promise<RunState> {
  const runsDir = options.runsDir ?? path.join('.claude', 'runs');
  await fs.mkdir(path.join(runsDir, options.runId), { recursive: true });
  const now = new Date().toISOString();
  const stepsInit = {} as Record<PipelineStep, StepState>;
  for (const step of ALL_STEPS) stepsInit[step] = { status: 'pending' };
  const state: RunState = {
    runId: options.runId, topic: options.topic,
    startedAt: now, lastUpdatedAt: now,
    status: 'in-progress', currentStep: null, steps: stepsInit,
  };
  await writeAtomic(stateFile(options.runId, runsDir), JSON.stringify(state, null, 2));
  return state;
}

export async function loadRunState(runId: string, runsDir?: string): Promise<RunState> {
  const dir = runsDir ?? path.join('.claude', 'runs');
  const file = stateFile(runId, dir);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as RunState;
  } catch (err) {
    throw new AutopilotError(`Run state not found: ${runId}`, {
      code: 'user_input',
      details: { runId, file, cause: err instanceof Error ? err.message : String(err) },
    });
  }
}

export interface UpdateStepOptions {
  runId: string;
  runsDir?: string;
  step: PipelineStep;
  update: Partial<StepState>;
}

export async function updateStepStatus(options: UpdateStepOptions): Promise<RunState> {
  const runsDir = options.runsDir ?? path.join('.claude', 'runs');
  const state = await loadRunState(options.runId, runsDir);
  state.steps[options.step] = { ...state.steps[options.step], ...options.update };
  state.lastUpdatedAt = new Date().toISOString();
  if (options.update.status === 'in-progress') state.currentStep = options.step;
  await writeAtomic(stateFile(options.runId, runsDir), JSON.stringify(state, null, 2));
  return state;
}
```

- [ ] **Step 2: Create `src/core/runtime/lock.ts` (stub)**

```typescript
// src/core/runtime/lock.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AutopilotError } from '../errors.ts';

export interface LockHandle {
  release(): Promise<void>;
}

export function acquireLock(runId: string, lockDir = '.claude'): LockHandle {
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, '.lock');
  try {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ runId, pid: process.pid, acquiredAt: new Date().toISOString() }),
      { flag: 'wx' }
    );
  } catch (err) {
    throw new AutopilotError('Another autopilot run holds the lock', {
      code: 'concurrency_lock',
      details: { lockPath, cause: err instanceof Error ? err.message : String(err) },
    });
  }
  return {
    release: async () => {
      try { await fs.promises.unlink(lockPath); } catch { /* best effort */ }
    },
  };
}
```

- [ ] **Step 3: Create `src/core/runtime/idempotency.ts`**

```typescript
// src/core/runtime/idempotency.ts

import { createHash } from 'node:crypto';

export function idempotencyKey(runId: string, step: string, inputs: Record<string, unknown>): string {
  const serialized = JSON.stringify({ runId, step, inputs });
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Write test**

```typescript
// tests/runtime-state.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRunState, loadRunState, updateStepStatus } from '../src/core/runtime/state.ts';

test('createRunState writes initial state with all steps pending', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-state-'));
  const state = await createRunState({ runId: 'r1', topic: 't', runsDir: tmpDir });
  assert.equal(state.runId, 'r1');
  for (const step of Object.values(state.steps)) assert.equal(step.status, 'pending');
  const loaded = await loadRunState('r1', tmpDir);
  assert.deepEqual(loaded, state);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('updateStepStatus persists completion', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-state-'));
  await createRunState({ runId: 'r2', topic: 'x', runsDir: tmpDir });
  await updateStepStatus({
    runId: 'r2', runsDir: tmpDir, step: 'plan',
    update: { status: 'completed', idempotencyKey: 'abc', artifact: 'docs/plans/x.md' },
  });
  const reloaded = await loadRunState('r2', tmpDir);
  assert.equal(reloaded.steps.plan.status, 'completed');
  assert.equal(reloaded.steps.plan.idempotencyKey, 'abc');
  await fs.rm(tmpDir, { recursive: true, force: true });
});
```

Run: `npx tsx --test tests/runtime-state.test.ts`
Expected: all 2 pass

- [ ] **Step 5: Commit**

```bash
git add src/core/runtime tests/runtime-state.test.ts
git commit -m "feat(runtime): state.json atomic persistence + lock stub + idempotencyKey"
```

---

## Task 12: Adapter loader (TEST 4)

**Files:**
- Create: `src/adapters/loader.ts`
- Test: `tests/adapter-loader.test.ts` (foundational TEST 4)

- [ ] **Step 1: Create `src/adapters/loader.ts`**

```typescript
// src/adapters/loader.ts

import * as path from 'node:path';
import { AutopilotError } from '../core/errors.ts';
import { checkApiVersionCompatibility, type AdapterBase } from './base.ts';

export type IntegrationPoint = 'review-engine' | 'vcs-host' | 'migration-runner' | 'review-bot-parser';

export interface LoadAdapterOptions {
  point: IntegrationPoint;
  ref: string;
  options?: Record<string, unknown>;
}

const BUILTIN_PATHS: Record<IntegrationPoint, Record<string, string>> = {
  'review-engine': { codex: './review-engine/codex.ts' },
  'vcs-host': { github: './vcs-host/github.ts' },
  'migration-runner': { supabase: './migration-runner/supabase.ts' },
  'review-bot-parser': { cursor: './review-bot-parser/cursor.ts' },
};

const REQUIRED_BY_POINT: Record<IntegrationPoint, string[]> = {
  'review-engine': ['review', 'estimateTokens'],
  'vcs-host': ['getPrDiff', 'getPrMetadata', 'postComment', 'getReviewComments', 'replyToComment', 'createPr', 'push'],
  'migration-runner': ['discover', 'dryRun', 'apply', 'ledger', 'alreadyApplied'],
  'review-bot-parser': ['detect', 'fetchFindings', 'detectDismissal'],
};

function isPathRef(ref: string): boolean {
  return ref.startsWith('./') || ref.startsWith('/') || ref.startsWith('../') || ref.endsWith('.ts') || ref.endsWith('.js');
}

export async function loadAdapter<T extends AdapterBase>(options: LoadAdapterOptions): Promise<T> {
  const { point, ref } = options;
  let modulePath: string;

  if (isPathRef(ref)) {
    modulePath = path.resolve(ref);
  } else {
    const builtin = BUILTIN_PATHS[point]?.[ref];
    if (!builtin) {
      throw new AutopilotError(`Unknown built-in ${point} adapter: "${ref}"`, {
        code: 'invalid_config',
        details: { point, ref, available: Object.keys(BUILTIN_PATHS[point] ?? {}) },
      });
    }
    modulePath = new URL(builtin, import.meta.url).pathname;
  }

  let mod: { default?: T } | T;
  try {
    mod = (await import(modulePath)) as { default?: T } | T;
  } catch (err) {
    throw new AutopilotError(`Failed to import adapter from ${modulePath}`, {
      code: 'invalid_config',
      details: { point, ref, modulePath, cause: err instanceof Error ? err.message : String(err) },
    });
  }

  const adapter = ('default' in mod ? mod.default : mod) as T;
  if (!adapter || typeof adapter !== 'object') {
    throw new AutopilotError(`Adapter module did not export a valid adapter object`, {
      code: 'invalid_config',
      details: { point, ref, modulePath },
    });
  }

  validateShape(adapter, point, modulePath);

  if (!checkApiVersionCompatibility(adapter.apiVersion)) {
    throw new AutopilotError(`Adapter apiVersion ${adapter.apiVersion} incompatible with core`, {
      code: 'invalid_config',
      details: { point, ref, adapterApiVersion: adapter.apiVersion },
    });
  }

  return adapter;
}

function validateShape(adapter: AdapterBase, point: IntegrationPoint, modulePath: string): void {
  const missing: string[] = [];
  const required = ['getCapabilities', ...REQUIRED_BY_POINT[point]];
  for (const method of required) {
    if (typeof (adapter as unknown as Record<string, unknown>)[method] !== 'function') missing.push(method);
  }
  if (typeof adapter.name !== 'string' || typeof adapter.apiVersion !== 'string') {
    missing.push('name/apiVersion');
  }
  if (missing.length > 0) {
    throw new AutopilotError(
      `Adapter at ${modulePath} missing required methods: ${missing.join(', ')}`,
      { code: 'invalid_config', details: { point, modulePath, missing } }
    );
  }
}
```

- [ ] **Step 2: Write test**

```typescript
// tests/adapter-loader.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadAdapter } from '../src/adapters/loader.ts';
import { AutopilotError } from '../src/core/errors.ts';

test('loadAdapter resolves built-in codex', async () => {
  const adapter = await loadAdapter({ point: 'review-engine', ref: 'codex' });
  assert.equal(adapter.name, 'codex');
});

test('loadAdapter resolves relative path', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-adapter-'));
  const fakePath = path.join(tmpDir, 'fake.ts');
  await fs.writeFile(fakePath, `
    export default {
      name: 'fake', apiVersion: '1.0.0',
      getCapabilities: () => ({}),
      review: async () => ({ findings: [], rawOutput: '' }),
      estimateTokens: () => 0,
    };
  `);
  const adapter = await loadAdapter({ point: 'review-engine', ref: fakePath });
  assert.equal(adapter.name, 'fake');
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('loadAdapter rejects unknown built-in', async () => {
  await assert.rejects(
    () => loadAdapter({ point: 'review-engine', ref: 'does-not-exist' }),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'invalid_config');
      return true;
    }
  );
});

test('loadAdapter rejects mismatched apiVersion major', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-adapter-'));
  const fakePath = path.join(tmpDir, 'v2.ts');
  await fs.writeFile(fakePath, `
    export default {
      name: 'v2', apiVersion: '2.0.0',
      getCapabilities: () => ({}),
      review: async () => ({ findings: [], rawOutput: '' }),
      estimateTokens: () => 0,
    };
  `);
  await assert.rejects(
    () => loadAdapter({ point: 'review-engine', ref: fakePath }),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'invalid_config');
      return true;
    }
  );
  await fs.rm(tmpDir, { recursive: true, force: true });
});
```

Note: test 1 (built-in codex) requires Task 13 (codex adapter) to exist before running. Mark as `.skip` until then.

- [ ] **Step 3: Commit (tests partial — codex adapter landed in Task 13)**

```bash
git add src/adapters/loader.ts tests/adapter-loader.test.ts
git commit -m "feat(adapters): loader resolves built-ins + paths + validates shape + apiVersion"
```

---

## Task 13: Port codex adapter

**Files:**
- Create: `src/adapters/review-engine/codex.ts`

- [ ] **Step 1: Create `src/adapters/review-engine/codex.ts`**

Port the existing `scripts/codex-review.ts` logic behind the `ReviewEngine` interface. Use the shell helper from Task 2 for any process invocation.

```typescript
// src/adapters/review-engine/codex.ts

import OpenAI from 'openai';
import type { Finding } from '../../core/findings/types.ts';
import { AutopilotError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from './types.ts';

const DEFAULT_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.3-codex';
const MAX_OUTPUT_TOKENS = 4096;

const SYSTEM_PROMPT_TEMPLATE = `You are a senior software architect providing feedback on designs, proposals, and ideas.

The codebase context:
{STACK}

Provide structured feedback in exactly this format:

## Review Summary
One paragraph overall assessment.

## Findings

For each finding, use this format:
### [CRITICAL|WARNING|NOTE] <short title>
<explanation>
**Suggestion:** <actionable fix>

Rules:
- CRITICAL: Blocks implementation
- WARNING: Should address before implementing
- NOTE: Improvement suggestion
- Maximum 10 findings, ranked by severity
- Be specific and constructive`;

export const codexAdapter: ReviewEngine = {
  name: 'codex',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false };
  },

  estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  },

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new AutopilotError('OPENAI_API_KEY not set', { code: 'auth', provider: 'codex' });
    }
    const stack = input.context?.stack ?? 'A web application — stack details unspecified.';
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{STACK}', stack);

    const client = new OpenAI({ apiKey });
    let response;
    try {
      response = await client.responses.create({
        model: DEFAULT_MODEL,
        instructions: systemPrompt,
        input: `Please review the following:\n\n---\n\n${input.content}`,
        max_output_tokens: MAX_OUTPUT_TOKENS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = /rate.limit|429/i.test(message);
      const isAuth = /unauthorized|401|invalid.api.key/i.test(message);
      throw new AutopilotError(`Codex review call failed: ${message}`, {
        code: isAuth ? 'auth' : isRateLimit ? 'rate_limit' : 'transient_network',
        provider: 'codex',
        retryable: isRateLimit,
      });
    }

    const rawOutput = response.output_text ?? '';
    return {
      findings: parseCodexOutput(rawOutput),
      rawOutput,
      usage: response.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : undefined,
    };
  },
};

export default codexAdapter;

function parseCodexOutput(output: string): Finding[] {
  const findings: Finding[] = [];
  const regex = /### \[(CRITICAL|WARNING|NOTE)\]\s*(.+?)(?=\n### \[|## Review Summary|$)/gs;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const severity = match[1]!.toLowerCase() as Finding['severity'];
    const body = match[2]!.trim();
    const titleEnd = body.indexOf('\n');
    const title = (titleEnd > 0 ? body.slice(0, titleEnd) : body).trim();
    const suggestion = body.match(/\*\*Suggestion:\*\*\s*(.+)/s)?.[1]?.trim();
    findings.push({
      id: `codex-${findings.length}`,
      source: 'review-engine',
      severity,
      category: 'codex-review',
      file: '<unspecified>',
      message: title,
      suggestion,
      protectedPath: false,
      createdAt: new Date().toISOString(),
    });
  }
  return findings;
}
```

- [ ] **Step 2: Un-skip the built-in codex test and run loader tests**

Run: `npx tsx --test tests/adapter-loader.test.ts`
Expected: all 4 pass

- [ ] **Step 3: Commit**

```bash
git add src/adapters/review-engine/codex.ts
git commit -m "feat(adapter/codex): port codex behind ReviewEngine interface (apiVersion 1.0.0)"
```

---

## Task 14: Port github, supabase, cursor adapters

**Files:**
- Create: `src/adapters/vcs-host/github.ts`
- Create: `src/adapters/migration-runner/supabase.ts`
- Create: `src/adapters/review-bot-parser/declarative-base.ts`
- Create: `src/adapters/review-bot-parser/cursor.ts`

All invocations of external processes go through the `runSafe` / `runThrowing` helpers from Task 2.

- [ ] **Step 1: Create github adapter** — wraps `gh` CLI via the shell helper; implements all `VcsHost` methods. Idempotency on `createPr` via `gh pr list --head=<branch>` check. Full file at `src/adapters/vcs-host/github.ts` following the types defined in Task 6.

- [ ] **Step 2: Create supabase adapter** — delegates to `scripts/supabase/migrate.ts` (if present in host repo). `discover` reads `data/deltas/*.sql`. `alreadyApplied` uses `--inspect` flag. Full file at `src/adapters/migration-runner/supabase.ts`.

- [ ] **Step 3: Create declarative-base** — `makeDeclarativeParser(config)` factory that returns a `ReviewBotParser`. Config fields: `name`, `author`, `severity` regex map, `dismissal` keywords. Full file at `src/adapters/review-bot-parser/declarative-base.ts`.

- [ ] **Step 4: Create cursor adapter** — one-liner using `makeDeclarativeParser` with cursor-specific config (`cursor[bot]` author, severity regex for `high`/`medium`/`low`, dismissal keywords `false positive`/`not an issue`/`intentional`/`wontfix`).

- [ ] **Step 5: Implementation details**

For this task, the implementer should use the exact code shapes from §4.2–4.4 of the spec, with these deviations:

- All `gh`/`git` invocations use `runSafe` or `runThrowing` from `src/core/shell.ts` — never direct imports of the Node process runner.
- `github.ts` `postComment` / `replyToComment` ignore `idempotencyKey` in alpha.1 (full dedup lands in alpha.3).
- `supabase.ts` `ledger` returns `[]` in alpha.1 (full ledger query lands in alpha.2).
- All four adapters declare `apiVersion: '1.0.0'`.

- [ ] **Step 6: Re-run adapter-loader test — all 4 built-ins now resolvable**

Run: `npx tsx --test tests/adapter-loader.test.ts`
Expected: all 4 tests pass

- [ ] **Step 7: Commit**

```bash
git add src/adapters/vcs-host src/adapters/migration-runner src/adapters/review-bot-parser
git commit -m "feat(adapters): port github + supabase + cursor behind new interfaces"
```

---

## Task 15: Ship nextjs-supabase preset

**Files:**
- Create: `presets/nextjs-supabase/autopilot.config.yaml`
- Create: `presets/nextjs-supabase/stack.md`
- Create: `presets/nextjs-supabase/rules/supabase-rls-bypass.ts`

- [ ] **Step 1: Create `presets/nextjs-supabase/autopilot.config.yaml`**

```yaml
configVersion: 1
reviewEngine: { adapter: codex }
vcsHost: { adapter: github }
migrationRunner: { adapter: supabase }
reviewBot: { adapter: cursor }
protectedPaths:
  - "**/auth/**"
  - "data/deltas/*.sql"
  - "**/payment/**"
  - "**/stripe/**"
  - "**/encryption/**"
  - "lib/supabase/**"
  - "app/api/**/route.ts"
  - "middleware.ts"
  - "utils/supabase/middleware.ts"
staticRules:
  - hardcoded-secrets
  - npm-audit
  - package-lock-sync
  - supabase-rls-bypass
thresholds:
  bugbotAutoFix: 85
  bugbotProposePatch: 60
  maxValidateRetries: 3
reviewStrategy: auto
chunking:
  smallTierMaxTokens: 8000
  partialReviewTokens: 60000
  perFileMaxTokens: 32000
```

- [ ] **Step 2: Create `presets/nextjs-supabase/stack.md`**

```markdown
A Next.js 16 App Router application with:
- TypeScript, React 19, Tailwind CSS
- Supabase (Postgres + RLS on all tables)
- Jest/Vitest for unit tests, Playwright for E2E
- OpenAI/Anthropic for LLM calls
- Optional: Weaviate multi-tenant (every query must include .withTenant())

Conventions:
- DB mutations go through server-side service functions
- API routes under app/api/ return NextResponse.json
- Service role key is SERVER-ONLY; never imported in client components
- Every table has RLS; bypass via createServiceRoleClient() is server-only

Things that should flag CRITICAL:
- createServiceRoleClient() in client-side code
- Raw SQL in route handlers
- Missing rate limit on public POST endpoints
- Weaviate queries without .withTenant()
- Secrets committed to code
- RLS policy DROP without replacement
```

- [ ] **Step 3: Create `presets/nextjs-supabase/rules/supabase-rls-bypass.ts`**

```typescript
// presets/nextjs-supabase/rules/supabase-rls-bypass.ts

import * as fs from 'node:fs/promises';
import type { Finding } from '../../../src/core/findings/types.ts';
import type { StaticRule } from '../../../src/core/phases/static-rules.ts';

export const supabaseRlsBypassRule: StaticRule = {
  name: 'supabase-rls-bypass',
  severity: 'critical',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    const clientSideFiles = touchedFiles.filter(f =>
      (f.endsWith('.tsx') || f.includes('/components/')) &&
      !f.includes('/api/') && !f.includes('.test.') && !f.includes('__tests__')
    );

    for (const file of clientSideFiles) {
      let content: string;
      try { content = await fs.readFile(file, 'utf8'); } catch { continue; }
      if (!content.includes('createServiceRoleClient')) continue;

      const lineIndex = content.split('\n').findIndex(l => l.includes('createServiceRoleClient'));
      findings.push({
        id: `supabase-rls-bypass-${file}-${lineIndex}`,
        source: 'static-rules',
        severity: 'critical',
        category: 'supabase-rls-bypass',
        file,
        line: lineIndex >= 0 ? lineIndex + 1 : undefined,
        message: 'createServiceRoleClient() in client-side code — service role key is a RLS bypass',
        suggestion: 'Use createServerSupabase in a server component or route handler',
        protectedPath: true,
        createdAt: new Date().toISOString(),
      });
    }
    return findings;
  },
};

export default supabaseRlsBypassRule;
```

- [ ] **Step 4: Un-skip preset-resolver test**

Modify `tests/preset-resolver.test.ts` to remove the `{ skip: ... }` option from the second test.

Run: `npx tsx --test tests/preset-resolver.test.ts`
Expected: all 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add presets/nextjs-supabase tests/preset-resolver.test.ts
git commit -m "feat(preset): nextjs-supabase (config + stack + supabase-rls-bypass invariant rule)"
```

---

## Task 16: Unified static-rules phase (TEST 5)

**Files:**
- Create: `src/core/phases/static-rules.ts`
- Test: `tests/fixtures/adapters/fake-rules.ts`
- Test: `tests/static-rules-phase.test.ts` (foundational TEST 5)

- [ ] **Step 1: Create `src/core/phases/static-rules.ts`**

```typescript
// src/core/phases/static-rules.ts

import type { Finding, FixAttempt, FixStatus } from '../findings/types.ts';
import { dedupFindings } from '../findings/dedup.ts';

export interface StaticRule {
  name: string;
  severity: 'critical' | 'warning' | 'note';
  check(touchedFiles: string[]): Promise<Finding[]>;
  autofix?(finding: Finding): Promise<FixStatus>;
}

export interface StaticRulesPhaseInput {
  touchedFiles: string[];
  rules: StaticRule[];
}

export interface StaticRulesPhaseResult {
  phase: 'static-rules';
  status: 'pass' | 'warn' | 'fail';
  findings: Finding[];
  fixAttempts: FixAttempt[];
  durationMs: number;
}

export async function runStaticRulesPhase(input: StaticRulesPhaseInput): Promise<StaticRulesPhaseResult> {
  const start = Date.now();

  let findings = dedupFindings(await runAllChecks(input.rules, input.touchedFiles));

  const fixAttempts: FixAttempt[] = [];
  let anyFixApplied = false;

  for (const finding of findings) {
    const rule = findRuleForFinding(input.rules, finding);
    if (!rule?.autofix) continue;

    if (finding.protectedPath) {
      fixAttempts.push({
        findingId: finding.id,
        attemptedAt: new Date().toISOString(),
        status: 'skipped',
        notes: 'protected path',
      });
      continue;
    }

    const status = await rule.autofix(finding);
    if (status === 'fixed') anyFixApplied = true;
    fixAttempts.push({ findingId: finding.id, attemptedAt: new Date().toISOString(), status });
  }

  if (anyFixApplied) {
    findings = dedupFindings(await runAllChecks(input.rules, input.touchedFiles));
  }

  const isFixed = (f: Finding): boolean =>
    fixAttempts.some(fa => fa.findingId === f.id && fa.status === 'fixed');
  const unfixedCritical = findings.some(f => f.severity === 'critical' && !isFixed(f));
  const unfixedWarning = findings.some(f => f.severity === 'warning' && !isFixed(f));

  let status: StaticRulesPhaseResult['status'];
  if (unfixedCritical) status = 'fail';
  else if (unfixedWarning) status = 'warn';
  else status = 'pass';

  return { phase: 'static-rules', status, findings, fixAttempts, durationMs: Date.now() - start };
}

async function runAllChecks(rules: StaticRule[], files: string[]): Promise<Finding[]> {
  const all: Finding[] = [];
  for (const rule of rules) all.push(...(await rule.check(files)));
  return all;
}

function findRuleForFinding(rules: StaticRule[], finding: Finding): StaticRule | undefined {
  return rules.find(r => r.name === finding.category) ?? rules.find(r => finding.category.includes(r.name));
}
```

- [ ] **Step 2: Create fake rules fixture**

```typescript
// tests/fixtures/adapters/fake-rules.ts

import type { Finding } from '../../../src/core/findings/types.ts';
import type { StaticRule } from '../../../src/core/phases/static-rules.ts';

export const fakeCleanRule: StaticRule = {
  name: 'fake-clean', severity: 'warning',
  async check() { return []; },
};

export const fakeCriticalRule: StaticRule = {
  name: 'fake-critical', severity: 'critical',
  async check(files: string[]): Promise<Finding[]> {
    if (files.length === 0) return [];
    return [{
      id: 'fc-1', source: 'static-rules', severity: 'critical',
      category: 'fake-critical', file: files[0]!,
      message: 'fake critical', protectedPath: false,
      createdAt: new Date().toISOString(),
    }];
  },
};

export const fakeAutofixingRule: StaticRule = {
  name: 'fake-autofix', severity: 'warning',
  async check(files: string[]): Promise<Finding[]> {
    if (files.length === 0) return [];
    return [{
      id: 'fa-1', source: 'static-rules', severity: 'warning',
      category: 'fake-autofix', file: files[0]!,
      message: 'fake autofixable warning', protectedPath: false,
      createdAt: new Date().toISOString(),
    }];
  },
  async autofix() { return 'fixed'; },
};

export const fakeProtectedAutofixRule: StaticRule = {
  name: 'fake-protected-autofix', severity: 'warning',
  async check(files: string[]): Promise<Finding[]> {
    if (files.length === 0) return [];
    return [{
      id: 'fp-1', source: 'static-rules', severity: 'warning',
      category: 'fake-protected-autofix', file: files[0]!,
      message: 'warning on protected path', protectedPath: true,
      createdAt: new Date().toISOString(),
    }];
  },
  async autofix() { return 'fixed'; },
};
```

- [ ] **Step 3: Write test**

```typescript
// tests/static-rules-phase.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStaticRulesPhase } from '../src/core/phases/static-rules.ts';
import {
  fakeCleanRule, fakeCriticalRule, fakeAutofixingRule, fakeProtectedAutofixRule,
} from './fixtures/adapters/fake-rules.ts';

test('clean diff returns pass', async () => {
  const r = await runStaticRulesPhase({ touchedFiles: ['src/x.ts'], rules: [fakeCleanRule] });
  assert.equal(r.status, 'pass');
  assert.equal(r.findings.length, 0);
});

test('critical finding returns fail', async () => {
  const r = await runStaticRulesPhase({ touchedFiles: ['src/x.ts'], rules: [fakeCriticalRule] });
  assert.equal(r.status, 'fail');
  assert.equal(r.findings.length, 1);
});

test('autofix applies and marks fix attempt', async () => {
  const r = await runStaticRulesPhase({ touchedFiles: ['src/x.ts'], rules: [fakeAutofixingRule] });
  assert.equal(r.fixAttempts.length, 1);
  assert.equal(r.fixAttempts[0]!.status, 'fixed');
});

test('autofix skipped on protected path', async () => {
  const r = await runStaticRulesPhase({ touchedFiles: ['src/x.ts'], rules: [fakeProtectedAutofixRule] });
  assert.equal(r.fixAttempts.length, 1);
  assert.equal(r.fixAttempts[0]!.status, 'skipped');
  assert.equal(r.fixAttempts[0]!.notes, 'protected path');
});
```

Run: `npx tsx --test tests/static-rules-phase.test.ts`
Expected: all 4 tests pass

- [ ] **Step 4: Commit**

```bash
git add src/core/phases/static-rules.ts tests/fixtures/adapters/fake-rules.ts tests/static-rules-phase.test.ts
git commit -m "feat(phase/static-rules): unified phase with autofix + global re-check"
```

---

## Task 17: Port preflight CLI

**Files:**
- Create: `src/cli/preflight.ts`

- [ ] **Step 1: Port existing `scripts/preflight.ts` logic into `src/cli/preflight.ts`, with:**
  - Additional check: `autopilot.config.yaml` exists in cwd (warn if missing)
  - Use `runSafe` from `src/core/shell.ts` instead of direct process runner imports
  - Shebang line `#!/usr/bin/env node` at top
  - Existing checks preserved: Node 22+, tsx, gh auth, gh connectivity, env file, OPENAI_API_KEY, git user, claude CLI, superpowers

- [ ] **Step 2: Sanity run**

Run: `npx tsx src/cli/preflight.ts`
Expected: runs checks and exits 0 or 1

- [ ] **Step 3: Commit**

```bash
git add src/cli/preflight.ts
git commit -m "feat(cli): port preflight with autopilot.config.yaml check"
```

---

## Task 18: Remove old scripts/ + .autopilot/, update README

**Files:**
- Delete: `scripts/` (entire directory)
- Delete: `.autopilot/` (entire directory)
- Modify: `README.md`

- [ ] **Step 1: Full typecheck + tests**

```bash
npx tsc --noEmit
npx tsx --test tests/**/*.test.ts
```
Expected: clean + all tests pass

- [ ] **Step 2: Remove old dirs**

```bash
rm -rf scripts/ .autopilot/
```

- [ ] **Step 3: Rewrite `README.md`**

```markdown
# claude-autopilot

End-to-end Claude Code pipeline: approved spec → plan → worktree → implementation → migrations → validation → PR → review engine → review-bot triage.

**Status: v1.0.0-alpha.1** — core architecture in place, ported adapters (codex, github, supabase, cursor), 1 preset (nextjs-supabase), 5 foundational tests. API may change through alpha.

Full design spec: `docs/superpowers/specs/2026-04-20-claude-autopilot-v1-design.md`
Implementation plans: `docs/superpowers/plans/`

## Changes in v1.0 (alpha.1)

- Four pluggable integration points (ReviewEngine, VcsHost, MigrationRunner, ReviewBotParser) with shared `AdapterBase`
- YAML config (`autopilot.config.yaml`) replaces `.autopilot/stack.md`
- Unified `Finding` type across validate + review-bot, with separate `TriageRecord[]` / `FixAttempt[]` history
- Merged static-rules phase with global re-check after autofix
- `AutopilotError` taxonomy with per-code retry policy
- `apiVersion` + `getCapabilities()` on every adapter

## Prerequisites

- Node 22+
- `gh` CLI authenticated
- `OPENAI_API_KEY` in `.env.local`

## Install

```bash
npm install --save-dev @delegance/claude-autopilot@alpha
```

## Usage (alpha.1)

CLI surface is limited to `preflight` in alpha.1. `run`, `init`, `validate`, `codex-pr-review`, `bugbot` land in alpha.4.

```bash
npx autopilot          # runs preflight
```

## Roadmap

- **alpha.2:** chunking, cost, cache, remaining adapters, 5 presets, 20 scenario tests
- **alpha.3:** idempotency wiring, concurrency, adapter trust, 60 conformance + 13 safety tests
- **alpha.4:** full CLI (init, install-github-action, run --resume, etc.) + programmatic API
- **beta → 1.0.0:** dogfood + npm publish

## License

MIT.
```

- [ ] **Step 4: Final typecheck + tests**

```bash
npx tsc --noEmit
npx tsx --test tests/**/*.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove v0.1 scripts + .autopilot; rewrite README for v1.0.0-alpha.1"
```

---

## Task 19: Tag alpha.1

- [ ] **Step 1: Verify clean tree**

Run: `git status`
Expected: "working tree clean"

- [ ] **Step 2: Tag + push**

```bash
git tag v1.0.0-alpha.1 -m "v1.0.0-alpha.1: architecture + ported adapters + nextjs-supabase preset + 5 tests"
git push origin master --tags
```

---

## Self-Review

**Foundational tests coverage (spec §10.3):**
- TEST 1 config-loader → Task 8 ✓
- TEST 2 findings-dedup → Task 4 ✓
- TEST 3 runtime-state → Task 11 ✓
- TEST 4 adapter-loader → Task 12 ✓
- TEST 5 static-rules-phase → Task 16 ✓

**Spec §3.1 src/ layout coverage (alpha.1 subset):**
- `src/core/errors.ts` → Task 3 ✓
- `src/core/findings/` → Task 4 ✓
- `src/core/config/` → Tasks 7, 8, 9 ✓
- `src/core/logging/` → Task 10 ✓
- `src/core/runtime/` → Task 11 ✓
- `src/core/phases/static-rules.ts` → Task 16 ✓
- `src/adapters/base.ts` → Task 5 ✓
- `src/adapters/*/types.ts` → Task 6 ✓
- `src/adapters/loader.ts` → Task 12 ✓
- `src/adapters/review-engine/codex.ts` → Task 13 ✓
- `src/adapters/vcs-host/github.ts` → Task 14 ✓
- `src/adapters/migration-runner/supabase.ts` → Task 14 ✓
- `src/adapters/review-bot-parser/{declarative-base, cursor}.ts` → Task 14 ✓
- `src/cli/preflight.ts` → Task 17 ✓

**Presets coverage:**
- `presets/nextjs-supabase/` → Task 15 ✓

**Cleanup:**
- Old `scripts/` + `.autopilot/` removed → Task 18 ✓

**Deferred (tracked in plans-to-come):**
- Chunking, cost, cache, remaining adapters, 4 more presets — alpha.2
- Idempotency wiring through adapters, full concurrency lock, adapter trust enforcement — alpha.3
- Full CLI (init, install-github-action, resume), programmatic API — alpha.4
- 60 conformance + 13 safety tests — alpha.3
- 20 scenario tests (other than the 5 foundational) — alpha.2

---

**Plan complete. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
