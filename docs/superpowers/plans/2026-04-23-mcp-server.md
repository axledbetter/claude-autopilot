# guardrail MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `guardrail mcp` — a stdio MCP server exposing six tools (review_diff, scan_files, get_findings, fix_finding, validate_fix, get_capabilities) so any MCP client can call guardrail natively without subprocess spawning.

**Architecture:** A new `src/cli/mcp.ts` entry point loads the guardrail config and review adapter once at startup, registers tools via `@modelcontextprotocol/sdk`, and connects a stdio transport. Tool handlers live in `src/core/mcp/handlers/` and call existing core modules directly. Findings are stored per-run with file checksums to enable safe fix application.

**Tech Stack:** `@modelcontextprotocol/sdk` ^1.29.0, Node 22 built-ins (`crypto`, `fs`, `path`), existing guardrail core (`runGuardrail`, `runReviewPhase`, `loadAdapter`, `loadConfig`)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/mcp/workspace.ts` | Create | `resolveWorkspace` + `assertInWorkspace` — path safety |
| `src/core/mcp/run-store.ts` | Create | Per-run finding persistence with file checksums |
| `src/core/mcp/concurrency.ts` | Create | Async write lock per workspace |
| `src/core/fix/generator.ts` | Create | Extract `generateFix` + helpers from fix.ts |
| `src/cli/fix.ts` | Modify | Import `generateFix` from core/fix/generator.ts |
| `src/core/mcp/handlers/get-capabilities.ts` | Create | Returns adapter/config metadata |
| `src/core/mcp/handlers/review-diff.ts` | Create | Wraps runGuardrail with git-touched files |
| `src/core/mcp/handlers/scan-files.ts` | Create | Wraps runReviewPhase with explicit file list |
| `src/core/mcp/handlers/get-findings.ts` | Create | Reads findings from run store by run_id |
| `src/core/mcp/handlers/validate-fix.ts` | Create | Runs testCommand, returns pass/fail |
| `src/core/mcp/handlers/fix-finding.ts` | Create | Checksum-validated fix application |
| `src/cli/mcp.ts` | Create | Server entry: adapter init, tool registration, stdio |
| `src/cli/index.ts` | Modify | Add `case 'mcp':` dispatch |
| `package.json` | Modify | Add `@modelcontextprotocol/sdk` dependency |
| `tests/mcp/workspace.test.ts` | Create | Unit tests |
| `tests/mcp/run-store.test.ts` | Create | Unit tests |
| `tests/mcp/concurrency.test.ts` | Create | Unit tests |
| `tests/mcp/handlers/get-capabilities.test.ts` | Create | Handler tests |
| `tests/mcp/handlers/review-diff.test.ts` | Create | Handler tests |
| `tests/mcp/handlers/scan-files.test.ts` | Create | Handler tests |
| `tests/mcp/handlers/get-findings.test.ts` | Create | Handler tests |
| `tests/mcp/handlers/validate-fix.test.ts` | Create | Handler tests |
| `tests/mcp/handlers/fix-finding.test.ts` | Create | Handler tests |

---

### Task 1: Path Safety Utilities

**Files:**
- Create: `src/core/mcp/workspace.ts`
- Create: `tests/mcp/workspace.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/mcp/workspace.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWorkspace, assertInWorkspace } from '../../src/core/mcp/workspace.ts';

describe('resolveWorkspace', () => {
  it('resolves process.cwd() when no cwd given', () => {
    const result = resolveWorkspace(undefined);
    assert.equal(result, fs.realpathSync(process.cwd()));
  });

  it('resolves a given directory to its realpath', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    assert.equal(resolveWorkspace(tmp), fs.realpathSync(tmp));
    fs.rmdirSync(tmp);
  });
});

describe('assertInWorkspace', () => {
  let tmp: string;

  it('returns realpath for a file inside workspace', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, '');
    const result = assertInWorkspace(tmp, 'foo.ts');
    assert.equal(result, fs.realpathSync(file));
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws for path traversal outside workspace', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    assert.throws(
      () => assertInWorkspace(tmp, '../../etc/passwd'),
      /outside workspace/,
    );
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws for absolute path outside workspace', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    assert.throws(
      () => assertInWorkspace(tmp, '/etc/passwd'),
      /outside workspace/,
    );
    fs.rmSync(tmp, { recursive: true });
  });

  it('allows absolute path inside workspace', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, '');
    const result = assertInWorkspace(tmp, file);
    assert.equal(result, fs.realpathSync(file));
    fs.rmSync(tmp, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -A3 "workspace"
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement workspace.ts**

```typescript
// src/core/mcp/workspace.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveWorkspace(cwd?: string): string {
  return fs.realpathSync(cwd ?? process.cwd());
}

export function assertInWorkspace(workspace: string, filePath: string): string {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspace, filePath);

  let resolved: string;
  try {
    resolved = fs.realpathSync(abs);
  } catch {
    // File doesn't exist yet — check the directory
    const dir = path.dirname(abs);
    const resolvedDir = fs.realpathSync(dir);
    resolved = path.join(resolvedDir, path.basename(abs));
  }

  const root = workspace.endsWith(path.sep) ? workspace : workspace + path.sep;
  if (!resolved.startsWith(root) && resolved !== workspace) {
    throw new Error(`Path "${filePath}" is outside workspace "${workspace}"`);
  }
  return resolved;
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -E "workspace|pass|fail" | tail -10
```
Expected: all workspace tests pass

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-autopilot
git add src/core/mcp/workspace.ts tests/mcp/workspace.test.ts
git commit -m "feat(mcp): path safety utilities — resolveWorkspace + assertInWorkspace"
```

---

### Task 2: Per-Run Finding Store

**Files:**
- Create: `src/core/mcp/run-store.ts`
- Create: `tests/mcp/run-store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/mcp/run-store.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveRun, loadRun, checksumFile, pruneOldRuns } from '../../src/core/mcp/run-store.ts';
import type { Finding } from '../../src/core/findings/types.ts';

const FINDING: Finding = {
  id: 'f1', source: 'static-rules', severity: 'critical',
  category: 'security', file: 'src/foo.ts', line: 10,
  message: 'test finding', protectedPath: false, createdAt: new Date().toISOString(),
};

describe('run-store', () => {
  let tmp: string;

  it('saves and loads a run', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-'));
    const runId = 'test-run-id';
    saveRun(tmp, runId, [FINDING], { 'src/foo.ts': 'abc123' });
    const loaded = loadRun(tmp, runId);
    assert.ok(loaded);
    assert.equal(loaded.run_id, runId);
    assert.equal(loaded.findings.length, 1);
    assert.equal(loaded.fileChecksums['src/foo.ts'], 'abc123');
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns null for missing run_id', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-'));
    const result = loadRun(tmp, 'nonexistent');
    assert.equal(result, null);
    fs.rmSync(tmp, { recursive: true });
  });

  it('checksumFile returns hex string for existing file', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-'));
    const file = path.join(tmp, 'test.ts');
    fs.writeFileSync(file, 'hello');
    const sum = checksumFile(file);
    assert.match(sum, /^[0-9a-f]{64}$/);
    fs.rmSync(tmp, { recursive: true });
  });

  it('checksumFile returns empty string for missing file', () => {
    assert.equal(checksumFile('/nonexistent/file.ts'), '');
  });

  it('pruneOldRuns removes runs older than maxAgeMs', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-'));
    saveRun(tmp, 'old-run', [], {});
    const runDir = path.join(tmp, '.guardrail-cache', 'runs');
    const oldFile = path.join(runDir, 'old-run.json');
    // backdate the file
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldTime, oldTime);
    saveRun(tmp, 'new-run', [], {});
    pruneOldRuns(tmp, 24 * 60 * 60 * 1000);
    assert.equal(fs.existsSync(oldFile), false);
    assert.ok(fs.existsSync(path.join(runDir, 'new-run.json')));
    fs.rmSync(tmp, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -A3 "run-store"
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement run-store.ts**

```typescript
// src/core/mcp/run-store.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Finding } from '../findings/types.ts';

const RUNS_DIR = '.guardrail-cache/runs';

export interface RunRecord {
  run_id: string;
  createdAt: string;
  findings: Finding[];
  fileChecksums: Record<string, string>;
}

function runsDir(cwd: string): string {
  return path.join(cwd, RUNS_DIR);
}

function runFilePath(cwd: string, runId: string): string {
  return path.join(runsDir(cwd), `${runId}.json`);
}

export function saveRun(
  cwd: string,
  runId: string,
  findings: Finding[],
  fileChecksums: Record<string, string>,
): void {
  const dir = runsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const record: RunRecord = { run_id: runId, createdAt: new Date().toISOString(), findings, fileChecksums };
  const tmp = runFilePath(cwd, runId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, runFilePath(cwd, runId));
}

export function loadRun(cwd: string, runId: string): RunRecord | null {
  const p = runFilePath(cwd, runId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}

export function checksumFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

export function pruneOldRuns(cwd: string, maxAgeMs: number): void {
  const dir = runsDir(cwd);
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -E "run-store|pass|fail" | tail -10
```
Expected: all run-store tests pass

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-autopilot
git add src/core/mcp/run-store.ts tests/mcp/run-store.test.ts
git commit -m "feat(mcp): per-run finding store with file checksums"
```

---

### Task 3: Async Write Lock

**Files:**
- Create: `src/core/mcp/concurrency.ts`
- Create: `tests/mcp/concurrency.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/mcp/concurrency.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { withWriteLock } from '../../src/core/mcp/concurrency.ts';

describe('withWriteLock', () => {
  it('runs a single task immediately', async () => {
    const result = await withWriteLock('/workspace/a', async () => 42);
    assert.equal(result, 42);
  });

  it('serializes concurrent writes to the same workspace', async () => {
    const order: number[] = [];
    const t1 = withWriteLock('/workspace/b', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(1);
    });
    const t2 = withWriteLock('/workspace/b', async () => {
      order.push(2);
    });
    await Promise.all([t1, t2]);
    assert.deepEqual(order, [1, 2]);
  });

  it('allows concurrent writes to different workspaces', async () => {
    const order: string[] = [];
    const t1 = withWriteLock('/workspace/c', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push('c1');
    });
    const t2 = withWriteLock('/workspace/d', async () => {
      order.push('d1');
    });
    await Promise.all([t1, t2]);
    // d1 should finish before c1 (no lock contention)
    assert.equal(order[0], 'd1');
    assert.equal(order[1], 'c1');
  });

  it('releases lock even when fn throws', async () => {
    await assert.rejects(
      () => withWriteLock('/workspace/e', async () => { throw new Error('boom'); }),
      /boom/,
    );
    // Should be able to acquire lock again
    const result = await withWriteLock('/workspace/e', async () => 'ok');
    assert.equal(result, 'ok');
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -A3 "concurrency"
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement concurrency.ts**

```typescript
// src/core/mcp/concurrency.ts
const mutexes = new Map<string, Promise<void>>();

export async function withWriteLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  let unlock!: () => void;
  const current = new Promise<void>(resolve => { unlock = resolve; });
  const prev = mutexes.get(workspace) ?? Promise.resolve();
  mutexes.set(workspace, current);

  await prev;
  try {
    return await fn();
  } finally {
    unlock();
    if (mutexes.get(workspace) === current) mutexes.delete(workspace);
  }
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -E "concurrency|pass|fail" | tail -10
```
Expected: all concurrency tests pass

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-autopilot
git add src/core/mcp/concurrency.ts tests/mcp/concurrency.test.ts
git commit -m "feat(mcp): async write lock per workspace"
```

---

### Task 4: Extract generateFix to Shared Core Module

**Files:**
- Create: `src/core/fix/generator.ts`
- Modify: `src/cli/fix.ts`

Background: `src/cli/fix.ts` contains `generateFix`, `validateReplacement`, and related helpers. The MCP `fix_finding` handler needs the same logic. This task extracts them into `src/core/fix/generator.ts` so both can share them without duplication.

- [ ] **Step 1: Create src/core/fix/generator.ts by extracting from fix.ts**

Open `src/cli/fix.ts`. Lines 24–70 contain `CONTEXT_LINES`, `REFUSAL_PHRASES`, `validateReplacement`, and `unifiedDiff`. Lines 295–370 contain `generateFix` and its interface. Extract all of these:

```typescript
// src/core/fix/generator.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from '../findings/types.ts';
import type { ReviewEngine } from '../../adapters/review-engine/types.ts';

export const CONTEXT_LINES = 20;

const REFUSAL_PHRASES = [
  'i cannot', "i can't", 'i am unable', 'as an ai', 'as a language model',
  'i apologize', "i'm sorry", 'cannot safely', 'would require', 'error:',
];

export interface GenerateResult {
  status: 'ok' | 'cannot_fix' | 'rejected' | 'error';
  reason?: string;
  originalLines?: string[];
  replacementLines?: string[];
  startLine?: number;
  endLine?: number;
}

export function validateReplacement(original: string[], replacement: string[], _finding: Finding): string | null {
  if (replacement.length === 0) return 'LLM returned empty output';
  const joined = replacement.join(' ').toLowerCase();
  for (const phrase of REFUSAL_PHRASES) {
    if (joined.includes(phrase)) return `LLM refused: "${replacement[0]?.slice(0, 60)}"`;
  }
  if (replacement.length > original.length * 3 + 10) {
    return `Suspicious: replacement is ${replacement.length} lines vs original ${original.length}`;
  }
  if (replacement.join('\n') === original.join('\n')) {
    return 'LLM returned identical code — no change made';
  }
  return null;
}

export function buildUnifiedDiff(original: string[], replacement: string[], filePath: string, startLine: number): string {
  const lines = [`--- ${filePath}`, `+++ ${filePath} (proposed fix)`, `@@ -${startLine},${original.length} +${startLine},${replacement.length} @@`];
  for (const l of original) lines.push(`- ${l}`);
  for (const l of replacement) lines.push(`+ ${l}`);
  return lines.join('\n');
}

export async function generateFix(finding: Finding, engine: ReviewEngine, cwd: string): Promise<GenerateResult> {
  if (!finding.line || !finding.file || finding.file === '<unspecified>' || finding.file === '<pipeline>') {
    return { status: 'cannot_fix', reason: 'finding has no file/line' };
  }

  const absPath = path.resolve(cwd, finding.file);
  let fileLines: string[];
  try {
    fileLines = fs.readFileSync(absPath, 'utf8').split('\n');
  } catch {
    return { status: 'cannot_fix', reason: 'file not readable' };
  }

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= fileLines.length) {
    return { status: 'cannot_fix', reason: 'line out of range' };
  }

  const startIdx = Math.max(0, lineIdx - CONTEXT_LINES);
  const endIdx = Math.min(fileLines.length - 1, lineIdx + CONTEXT_LINES);
  const contextLines = fileLines.slice(startIdx, endIdx + 1);
  const startLine = startIdx + 1;

  const numbered = contextLines
    .map((l, i) => {
      const n = startLine + i;
      return `${n === finding.line ? '>>>' : '   '} ${String(n).padStart(4)}: ${l}`;
    })
    .join('\n');

  const prompt = [
    `File: ${finding.file}`,
    `Finding (line ${finding.line}): [${finding.severity.toUpperCase()}] ${finding.message}`,
    finding.suggestion ? `Suggestion: ${finding.suggestion}` : '',
    '',
    'Relevant lines (>>> marks the finding):',
    '```',
    numbered,
    '```',
    '',
    `Rewrite ONLY lines ${startLine}–${endIdx + 1} to fix this finding.`,
    'Rules:',
    '- Output ONLY the replacement lines with no explanation, no markdown fences, no line numbers',
    '- Preserve indentation exactly',
    '- Make the minimal change needed — do not refactor unrelated code',
    '- If the fix cannot be done safely in this context, output exactly: CANNOT_FIX',
  ]
    .filter(Boolean)
    .join('\n');

  let rawOutput: string;
  try {
    const output = await engine.review({ content: prompt, kind: 'file-batch' });
    rawOutput = output.rawOutput.trim();
  } catch (err) {
    return { status: 'error', reason: `LLM error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (rawOutput === 'CANNOT_FIX' || rawOutput.startsWith('CANNOT_FIX')) {
    return { status: 'cannot_fix', reason: 'LLM: cannot fix safely in this context' };
  }

  const cleaned = rawOutput
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/\n?```$/, '')
    .trimEnd();

  const replacementLines = cleaned.split('\n');
  const originalLines = contextLines;

  const validationError = validateReplacement(originalLines, replacementLines, finding);
  if (validationError) {
    return { status: 'rejected', reason: validationError };
  }

  return { status: 'ok', originalLines, replacementLines, startLine, endLine: endIdx + 1 };
}
```

- [ ] **Step 2: Update src/cli/fix.ts to import from generator**

In `src/cli/fix.ts`:
1. Remove `CONTEXT_LINES`, `REFUSAL_PHRASES`, `validateReplacement`, `unifiedDiff` (lines 24–70) and the full `generateFix` function + `GenerateResult` interface (lines ~284–370)
2. Add import at the top (after existing imports):

```typescript
import { generateFix, buildUnifiedDiff } from '../core/fix/generator.ts';
import type { GenerateResult } from '../core/fix/generator.ts';
```

3. Replace calls to the local `unifiedDiff(...)` with `buildUnifiedDiff(...)` (same signature, renamed for clarity)

- [ ] **Step 3: Run full test suite to confirm nothing broke**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | tail -10
```
Expected: same pass count as before, 0 failures

- [ ] **Step 4: Commit**

```bash
cd /tmp/claude-autopilot
git add src/core/fix/generator.ts src/cli/fix.ts
git commit -m "refactor(fix): extract generateFix to src/core/fix/generator.ts"
```

---

### Task 5: get_capabilities Handler

**Files:**
- Create: `src/core/mcp/handlers/get-capabilities.ts`
- Create: `tests/mcp/handlers/get-capabilities.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/mcp/handlers/get-capabilities.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleGetCapabilities } from '../../../src/core/mcp/handlers/get-capabilities.ts';
import type { GuardrailConfig } from '../../../src/core/config/types.ts';

const BASE_CONFIG: GuardrailConfig = { configVersion: 1 };

describe('handleGetCapabilities', () => {
  let tmp: string;

  it('returns schema_version, adapter, guardrailVersion', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-test-'));
    const result = await handleGetCapabilities({ cwd: tmp }, BASE_CONFIG, 'claude');
    assert.equal(result.schema_version, 1);
    assert.equal(result.adapter, 'claude');
    assert.ok(typeof result.guardrailVersion === 'string');
    assert.ok(Array.isArray(result.enabledRules));
    assert.ok(typeof result.writeable === 'boolean');
    assert.ok(typeof result.gitAvailable === 'boolean');
    assert.ok(typeof result.testCommandConfigured === 'boolean');
    fs.rmSync(tmp, { recursive: true });
  });

  it('testCommandConfigured is true when config has testCommand', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-test-'));
    const cfg = { ...BASE_CONFIG, testCommand: 'npm test' };
    const result = await handleGetCapabilities({ cwd: tmp }, cfg, 'gemini');
    assert.equal(result.testCommandConfigured, true);
    fs.rmSync(tmp, { recursive: true });
  });

  it('enabledRules reflects config staticRules', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-test-'));
    const cfg = { ...BASE_CONFIG, staticRules: ['console-log', 'sql-injection'] as const };
    const result = await handleGetCapabilities({ cwd: tmp }, cfg, 'claude');
    assert.deepEqual(result.enabledRules, ['console-log', 'sql-injection']);
    fs.rmSync(tmp, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -A3 "get-capabilities"
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement get-capabilities.ts**

```typescript
// src/core/mcp/handlers/get-capabilities.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWorkspace } from '../workspace.ts';
import type { GuardrailConfig } from '../../config/types.ts';

export interface CapabilitiesResult {
  schema_version: 1;
  adapter: string;
  enabledRules: string[];
  writeable: boolean;
  gitAvailable: boolean;
  testCommandConfigured: boolean;
  guardrailVersion: string;
}

function readVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../package.json');
    return (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function isGitAvailable(workspace: string): boolean {
  try {
    child_process.execFileSync('git', ['rev-parse', '--git-dir'], { cwd: workspace, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function extractRuleIds(rules: GuardrailConfig['staticRules']): string[] {
  if (!rules) return [];
  return rules.map(r => typeof r === 'string' ? r : r.adapter);
}

export async function handleGetCapabilities(
  input: { cwd?: string },
  config: GuardrailConfig,
  adapterName: string,
): Promise<CapabilitiesResult> {
  const workspace = resolveWorkspace(input.cwd);
  return {
    schema_version: 1,
    adapter: adapterName,
    enabledRules: extractRuleIds(config.staticRules),
    writeable: true,
    gitAvailable: isGitAvailable(workspace),
    testCommandConfigured: !!config.testCommand,
    guardrailVersion: readVersion(),
  };
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -E "capabilities|pass|fail" | tail -10
```
Expected: all capabilities tests pass

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-autopilot
git add src/core/mcp/handlers/get-capabilities.ts tests/mcp/handlers/get-capabilities.test.ts
git commit -m "feat(mcp): get_capabilities handler"
```

---

### Task 6: review_diff Handler

**Files:**
- Create: `src/core/mcp/handlers/review-diff.ts`
- Create: `tests/mcp/handlers/review-diff.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/mcp/handlers/review-diff.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleReviewDiff } from '../../../src/core/mcp/handlers/review-diff.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from '../../../src/adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../../src/core/config/types.ts';

function makeEngine(findings = []): ReviewEngine {
  return {
    name: 'mock',
    apiVersion: '1.0.0',
    getCapabilities: () => ({ structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false }),
    estimateTokens: (c: string) => c.length,
    review: async (_input: ReviewInput): Promise<ReviewOutput> => ({ findings, rawOutput: '## Review Summary\nAll good.', usage: undefined }),
  };
}

const BASE_CONFIG: GuardrailConfig = { configVersion: 1 };

describe('handleReviewDiff', () => {
  let tmp: string;

  it('returns run_id, findings, human_summary when no touched files', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diff-test-'));
    // Init git repo with no changes
    fs.execFileSync = () => Buffer.from(''); // Can't easily test git — use static_only
    const result = await handleReviewDiff(
      { cwd: tmp, static_only: true },
      BASE_CONFIG,
      makeEngine(),
    );
    assert.equal(result.schema_version, 1);
    assert.ok(typeof result.run_id === 'string');
    assert.ok(Array.isArray(result.findings));
    assert.ok(typeof result.human_summary === 'string');
    fs.rmSync(tmp, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -A3 "review-diff"
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement review-diff.ts**

```typescript
// src/core/mcp/handlers/review-diff.ts
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { resolveWorkspace } from '../workspace.ts';
import { saveRun, checksumFile, pruneOldRuns } from '../run-store.ts';
import { runGuardrail } from '../../pipeline/run.ts';
import { resolveGitTouchedFiles } from '../../git/touched-files.ts';
import { loadRulesFromConfig } from '../../static-rules/registry.ts';
import { detectStack } from '../../detect/stack.ts';
import { detectGitContext } from '../../detect/git-context.ts';
import type { ReviewEngine } from '../../../adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../config/types.ts';
import type { Finding } from '../../findings/types.ts';

export interface ReviewDiffResult {
  schema_version: 1;
  run_id: string;
  findings: Finding[];
  human_summary: string;
  usage?: { costUSD?: number };
}

export async function handleReviewDiff(
  input: { base?: string; cwd?: string; static_only?: boolean },
  config: GuardrailConfig,
  engine: ReviewEngine,
): Promise<ReviewDiffResult> {
  const workspace = resolveWorkspace(input.cwd);
  pruneOldRuns(workspace, 24 * 60 * 60 * 1000);

  const touchedFiles = resolveGitTouchedFiles({ cwd: workspace, base: input.base });
  const staticRules = config.staticRules ? await loadRulesFromConfig(config.staticRules) : [];
  const stack = detectStack(workspace) ?? config.stack;
  const gitCtx = detectGitContext(workspace);

  const result = await runGuardrail({
    touchedFiles,
    config,
    reviewEngine: engine,
    staticRules,
    cwd: workspace,
    gitSummary: gitCtx.summary ?? undefined,
    base: input.base,
    skipReview: input.static_only ?? false,
  });

  const run_id = crypto.randomUUID();
  const fileChecksums: Record<string, string> = {};
  for (const f of touchedFiles) {
    const abs = path.isAbsolute(f) ? f : path.resolve(workspace, f);
    fileChecksums[f] = checksumFile(abs);
  }
  saveRun(workspace, run_id, result.allFindings, fileChecksums);

  const critCount = result.allFindings.filter(f => f.severity === 'critical').length;
  const warnCount = result.allFindings.filter(f => f.severity === 'warning').length;
  const human_summary = result.allFindings.length === 0
    ? 'No findings — looks clean.'
    : `${result.allFindings.length} finding${result.allFindings.length !== 1 ? 's' : ''}: ${critCount} critical, ${warnCount} warning.`;

  return {
    schema_version: 1,
    run_id,
    findings: result.allFindings,
    human_summary,
    usage: result.totalCostUSD !== undefined ? { costUSD: result.totalCostUSD } : undefined,
  };
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -E "review-diff|pass|fail" | tail -10
```
Expected: all review-diff tests pass

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-autopilot
git add src/core/mcp/handlers/review-diff.ts tests/mcp/handlers/review-diff.test.ts
git commit -m "feat(mcp): review_diff handler"
```

---

### Task 7: scan_files Handler

**Files:**
- Create: `src/core/mcp/handlers/scan-files.ts`
- Create: `tests/mcp/handlers/scan-files.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/mcp/handlers/scan-files.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleScanFiles } from '../../../src/core/mcp/handlers/scan-files.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from '../../../src/adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../../src/core/config/types.ts';

function makeEngine(): ReviewEngine {
  return {
    name: 'mock', apiVersion: '1.0.0',
    getCapabilities: () => ({ structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false }),
    estimateTokens: (c: string) => c.length,
    review: async (_: ReviewInput): Promise<ReviewOutput> => ({
      findings: [], rawOutput: '## Review Summary\nNo issues.', usage: undefined,
    }),
  };
}

const BASE_CONFIG: GuardrailConfig = { configVersion: 1 };

describe('handleScanFiles', () => {
  let tmp: string;

  it('returns run_id and findings for given files', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, 'const x = 1;');
    const result = await handleScanFiles(
      { files: [file], cwd: tmp },
      BASE_CONFIG,
      makeEngine(),
    );
    assert.equal(result.schema_version, 1);
    assert.ok(typeof result.run_id === 'string');
    assert.ok(Array.isArray(result.findings));
    assert.ok(typeof result.human_summary === 'string');
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws path_violation for files outside workspace', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
    await assert.rejects(
      () => handleScanFiles({ files: ['/etc/passwd'], cwd: tmp }, BASE_CONFIG, makeEngine()),
      /outside workspace/,
    );
    fs.rmSync(tmp, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -A3 "scan-files"
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement scan-files.ts**

```typescript
// src/core/mcp/handlers/scan-files.ts
import * as crypto from 'node:crypto';
import { resolveWorkspace, assertInWorkspace } from '../workspace.ts';
import { saveRun, checksumFile, pruneOldRuns } from '../run-store.ts';
import { runReviewPhase } from '../../pipeline/review-phase.ts';
import { detectStack } from '../../detect/stack.ts';
import type { ReviewEngine } from '../../../adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../config/types.ts';
import type { Finding } from '../../findings/types.ts';

export interface ScanFilesResult {
  schema_version: 1;
  run_id: string;
  findings: Finding[];
  human_summary: string;
}

export async function handleScanFiles(
  input: { files: string[]; cwd?: string; ask?: string },
  config: GuardrailConfig,
  engine: ReviewEngine,
): Promise<ScanFilesResult> {
  const workspace = resolveWorkspace(input.cwd);
  pruneOldRuns(workspace, 24 * 60 * 60 * 1000);

  // Validate all paths before any I/O
  const resolvedFiles = input.files.map(f => assertInWorkspace(workspace, f));

  const stack = detectStack(workspace) ?? config.stack;
  const contextOverride = input.ask
    ? { ...(config as object), stack: `${stack ?? 'unknown'}\n\nFocus: ${input.ask}` }
    : config;

  const result = await runReviewPhase({
    touchedFiles: resolvedFiles,
    config: contextOverride as GuardrailConfig,
    engine,
    cwd: workspace,
  });

  const run_id = crypto.randomUUID();
  const fileChecksums: Record<string, string> = {};
  for (const f of resolvedFiles) {
    fileChecksums[f] = checksumFile(f);
  }
  saveRun(workspace, run_id, result.findings, fileChecksums);

  const critCount = result.findings.filter(f => f.severity === 'critical').length;
  const warnCount = result.findings.filter(f => f.severity === 'warning').length;
  const human_summary = result.findings.length === 0
    ? 'No findings.'
    : `${result.findings.length} finding${result.findings.length !== 1 ? 's' : ''}: ${critCount} critical, ${warnCount} warning.`;

  return { schema_version: 1, run_id, findings: result.findings, human_summary };
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -E "scan-files|pass|fail" | tail -10
```
Expected: all scan-files tests pass

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-autopilot
git add src/core/mcp/handlers/scan-files.ts tests/mcp/handlers/scan-files.test.ts
git commit -m "feat(mcp): scan_files handler"
```

---

### Task 8: get_findings and validate_fix Handlers

**Files:**
- Create: `src/core/mcp/handlers/get-findings.ts`
- Create: `src/core/mcp/handlers/validate-fix.ts`
- Create: `tests/mcp/handlers/get-findings.test.ts`
- Create: `tests/mcp/handlers/validate-fix.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/mcp/handlers/get-findings.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleGetFindings } from '../../../src/core/mcp/handlers/get-findings.ts';
import { saveRun } from '../../../src/core/mcp/run-store.ts';
import type { Finding } from '../../../src/core/findings/types.ts';

const FINDINGS: Finding[] = [
  { id: 'f1', source: 'static-rules', severity: 'critical', category: 'security', file: 'a.ts', line: 1, message: 'critical issue', protectedPath: false, createdAt: new Date().toISOString() },
  { id: 'f2', source: 'static-rules', severity: 'warning', category: 'style', file: 'b.ts', line: 2, message: 'warning issue', protectedPath: false, createdAt: new Date().toISOString() },
  { id: 'f3', source: 'static-rules', severity: 'note', category: 'style', file: 'c.ts', line: 3, message: 'note issue', protectedPath: false, createdAt: new Date().toISOString() },
];

describe('handleGetFindings', () => {
  let tmp: string;

  it('returns all findings for a run_id', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'get-findings-test-'));
    saveRun(tmp, 'run1', FINDINGS, {});
    const result = await handleGetFindings({ run_id: 'run1', cwd: tmp });
    assert.equal(result.schema_version, 1);
    assert.equal(result.findings.length, 3);
    assert.ok(typeof result.cachedAt === 'string');
    fs.rmSync(tmp, { recursive: true });
  });

  it('filters by severity critical', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'get-findings-test-'));
    saveRun(tmp, 'run2', FINDINGS, {});
    const result = await handleGetFindings({ run_id: 'run2', severity: 'critical', cwd: tmp });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'critical');
    fs.rmSync(tmp, { recursive: true });
  });

  it('filters by severity warning returns critical+warning', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'get-findings-test-'));
    saveRun(tmp, 'run3', FINDINGS, {});
    const result = await handleGetFindings({ run_id: 'run3', severity: 'warning', cwd: tmp });
    assert.equal(result.findings.length, 2);
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws for missing run_id', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'get-findings-test-'));
    await assert.rejects(
      () => handleGetFindings({ run_id: 'nonexistent', cwd: tmp }),
      /run_not_found/,
    );
    fs.rmSync(tmp, { recursive: true });
  });
});
```

```typescript
// tests/mcp/handlers/validate-fix.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleValidateFix } from '../../../src/core/mcp/handlers/validate-fix.ts';
import type { GuardrailConfig } from '../../../src/core/config/types.ts';

describe('handleValidateFix', () => {
  let tmp: string;

  it('returns passed:true when no testCommand configured', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-test-'));
    const config: GuardrailConfig = { configVersion: 1 };
    const result = await handleValidateFix({ cwd: tmp }, config);
    assert.equal(result.schema_version, 1);
    assert.equal(result.passed, true);
    assert.ok(typeof result.durationMs === 'number');
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns passed:true for passing testCommand', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-test-'));
    const config: GuardrailConfig = { configVersion: 1, testCommand: 'echo ok' };
    const result = await handleValidateFix({ cwd: tmp }, config);
    assert.equal(result.passed, true);
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns passed:false for failing testCommand', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-test-'));
    const config: GuardrailConfig = { configVersion: 1, testCommand: 'exit 1' };
    const result = await handleValidateFix({ cwd: tmp }, config);
    assert.equal(result.passed, false);
    fs.rmSync(tmp, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -A3 "get-findings\|validate-fix"
```
Expected: FAIL — modules not found

- [ ] **Step 3: Implement get-findings.ts**

```typescript
// src/core/mcp/handlers/get-findings.ts
import { resolveWorkspace } from '../workspace.ts';
import { loadRun } from '../run-store.ts';
import type { Finding, Severity } from '../../findings/types.ts';

export interface GetFindingsResult {
  schema_version: 1;
  run_id: string;
  findings: Finding[];
  cachedAt: string;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'note'];

export async function handleGetFindings(input: {
  run_id: string;
  severity?: Severity;
  cwd?: string;
}): Promise<GetFindingsResult> {
  const workspace = resolveWorkspace(input.cwd);
  const record = loadRun(workspace, input.run_id);
  if (!record) {
    throw Object.assign(new Error(`run_not_found: no run with id "${input.run_id}"`), { code: 'run_not_found' });
  }

  let findings = record.findings;
  if (input.severity) {
    const minIdx = SEVERITY_ORDER.indexOf(input.severity);
    findings = findings.filter(f => SEVERITY_ORDER.indexOf(f.severity) <= minIdx);
  }

  return { schema_version: 1, run_id: input.run_id, findings, cachedAt: record.createdAt };
}
```

- [ ] **Step 4: Implement validate-fix.ts**

```typescript
// src/core/mcp/handlers/validate-fix.ts
import { spawnSync } from 'node:child_process';
import { resolveWorkspace } from '../workspace.ts';
import { withWriteLock } from '../concurrency.ts';
import type { GuardrailConfig } from '../../config/types.ts';

export interface ValidateFixResult {
  schema_version: 1;
  passed: boolean;
  output: string;
  durationMs: number;
}

export async function handleValidateFix(
  input: { cwd?: string; files?: string[] },
  config: GuardrailConfig,
): Promise<ValidateFixResult> {
  const workspace = resolveWorkspace(input.cwd);

  if (!config.testCommand) {
    return { schema_version: 1, passed: true, output: '', durationMs: 0 };
  }

  return withWriteLock(workspace, async () => {
    const start = Date.now();
    const result = spawnSync(config.testCommand!, {
      cwd: workspace,
      shell: process.env.SHELL ?? '/bin/sh',
      timeout: 120_000,
      encoding: 'utf8',
    });
    const durationMs = Date.now() - start;
    const raw = ((result.stdout ?? '') + (result.stderr ?? '')).slice(0, 4000);

    return {
      schema_version: 1 as const,
      passed: result.status === 0,
      output: raw,
      durationMs,
    };
  });
}
```

- [ ] **Step 5: Run tests to confirm pass**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -E "get-findings|validate-fix|pass|fail" | tail -10
```
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
cd /tmp/claude-autopilot
git add src/core/mcp/handlers/get-findings.ts src/core/mcp/handlers/validate-fix.ts \
        tests/mcp/handlers/get-findings.test.ts tests/mcp/handlers/validate-fix.test.ts
git commit -m "feat(mcp): get_findings and validate_fix handlers"
```

---

### Task 9: fix_finding Handler

**Files:**
- Create: `src/core/mcp/handlers/fix-finding.ts`
- Create: `tests/mcp/handlers/fix-finding.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/mcp/handlers/fix-finding.test.ts
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleFixFinding } from '../../../src/core/mcp/handlers/fix-finding.ts';
import { saveRun, checksumFile } from '../../../src/core/mcp/run-store.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from '../../../src/adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../../src/core/config/types.ts';
import type { Finding } from '../../../src/core/findings/types.ts';

function makeEngine(patch = 'const x = 2;'): ReviewEngine {
  return {
    name: 'mock', apiVersion: '1.0.0',
    getCapabilities: () => ({ structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false }),
    estimateTokens: (c: string) => c.length,
    review: async (_: ReviewInput): Promise<ReviewOutput> => ({ findings: [], rawOutput: patch, usage: undefined }),
  };
}

const BASE_CONFIG: GuardrailConfig = { configVersion: 1 };

describe('handleFixFinding', () => {
  let tmp: string;

  it('returns skipped for dry_run:true', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-finding-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, 'const x = 1;\n');
    const finding: Finding = {
      id: 'f1', source: 'review-engine', severity: 'critical', category: 'security',
      file: 'foo.ts', line: 1, message: 'bad code', protectedPath: false,
      createdAt: new Date().toISOString(),
    };
    saveRun(tmp, 'run1', [finding], { 'foo.ts': checksumFile(file) });
    const result = await handleFixFinding(
      { run_id: 'run1', finding_id: 'f1', cwd: tmp, dry_run: true },
      BASE_CONFIG,
      makeEngine(),
    );
    assert.equal(result.status, 'skipped');
    assert.ok(typeof result.patch === 'string');
    assert.deepEqual(result.appliedFiles, []);
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns human_required when file checksum drifted', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-finding-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, 'const x = 1;\n');
    const finding: Finding = {
      id: 'f1', source: 'review-engine', severity: 'critical', category: 'security',
      file: 'foo.ts', line: 1, message: 'bad code', protectedPath: false,
      createdAt: new Date().toISOString(),
    };
    // Save run with stale checksum
    saveRun(tmp, 'run2', [finding], { 'foo.ts': 'stale_checksum' });
    const result = await handleFixFinding(
      { run_id: 'run2', finding_id: 'f1', cwd: tmp },
      BASE_CONFIG,
      makeEngine(),
    );
    assert.equal(result.status, 'human_required');
    assert.equal(result.reason, 'file_changed');
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns human_required for protected path', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-finding-test-'));
    const file = path.join(tmp, 'migrations', 'foo.sql');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'SELECT 1;');
    const finding: Finding = {
      id: 'f1', source: 'review-engine', severity: 'critical', category: 'security',
      file: 'migrations/foo.sql', line: 1, message: 'bad', protectedPath: true,
      createdAt: new Date().toISOString(),
    };
    saveRun(tmp, 'run3', [finding], { 'migrations/foo.sql': checksumFile(file) });
    const config = { ...BASE_CONFIG, protectedPaths: ['migrations/**'] };
    const result = await handleFixFinding(
      { run_id: 'run3', finding_id: 'f1', cwd: tmp },
      config,
      makeEngine(),
    );
    assert.equal(result.status, 'human_required');
    assert.equal(result.reason, 'protected_path');
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws for missing run_id', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-finding-test-'));
    await assert.rejects(
      () => handleFixFinding({ run_id: 'nonexistent', finding_id: 'f1', cwd: tmp }, BASE_CONFIG, makeEngine()),
      /run_not_found/,
    );
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws for missing finding_id', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-finding-test-'));
    saveRun(tmp, 'run4', [], {});
    await assert.rejects(
      () => handleFixFinding({ run_id: 'run4', finding_id: 'nonexistent', cwd: tmp }, BASE_CONFIG, makeEngine()),
      /finding_not_found/,
    );
    fs.rmSync(tmp, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -A3 "fix-finding"
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement fix-finding.ts**

```typescript
// src/core/mcp/handlers/fix-finding.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveWorkspace } from '../workspace.ts';
import { loadRun, checksumFile } from '../run-store.ts';
import { withWriteLock } from '../concurrency.ts';
import { generateFix, buildUnifiedDiff } from '../../fix/generator.ts';
import type { ReviewEngine } from '../../../adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../config/types.ts';

export interface FixFindingResult {
  schema_version: 1;
  status: 'fixed' | 'reverted' | 'human_required' | 'skipped';
  reason?: string;
  patch?: string;
  commitSha?: string;
  appliedFiles: string[];
}

export async function handleFixFinding(
  input: { run_id: string; finding_id: string; cwd?: string; dry_run?: boolean },
  config: GuardrailConfig,
  engine: ReviewEngine,
): Promise<FixFindingResult> {
  const workspace = resolveWorkspace(input.cwd);

  const record = loadRun(workspace, input.run_id);
  if (!record) {
    throw Object.assign(new Error(`run_not_found: no run with id "${input.run_id}"`), { code: 'run_not_found' });
  }

  const finding = record.findings.find(f => f.id === input.finding_id);
  if (!finding) {
    throw Object.assign(new Error(`finding_not_found: no finding with id "${input.finding_id}"`), { code: 'finding_not_found' });
  }

  if (finding.protectedPath) {
    return { schema_version: 1, status: 'human_required', reason: 'protected_path', appliedFiles: [] };
  }

  // Checksum validation
  const absFile = path.resolve(workspace, finding.file);
  const currentChecksum = checksumFile(absFile);
  const savedChecksum = record.fileChecksums[finding.file] ?? '';
  if (savedChecksum && currentChecksum !== savedChecksum) {
    return { schema_version: 1, status: 'human_required', reason: 'file_changed', appliedFiles: [] };
  }

  // Generate fix
  const genResult = await generateFix(finding, engine, workspace);

  if (genResult.status === 'cannot_fix' || genResult.status === 'error') {
    return { schema_version: 1, status: 'human_required', reason: genResult.reason, appliedFiles: [] };
  }
  if (genResult.status === 'rejected') {
    return { schema_version: 1, status: 'human_required', reason: genResult.reason, appliedFiles: [] };
  }

  const patch = buildUnifiedDiff(
    genResult.originalLines!,
    genResult.replacementLines!,
    finding.file,
    genResult.startLine!,
  );

  if (input.dry_run) {
    return { schema_version: 1, status: 'skipped', reason: 'dry_run', patch, appliedFiles: [] };
  }

  return withWriteLock(workspace, async () => {
    const originalContent = fs.readFileSync(absFile, 'utf8');
    const allLines = originalContent.split('\n');
    const newLines = [
      ...allLines.slice(0, genResult.startLine! - 1),
      ...genResult.replacementLines!,
      ...allLines.slice(genResult.endLine!),
    ];

    const tmp = absFile + '.guardrail.tmp';
    fs.writeFileSync(tmp, newLines.join('\n'), 'utf8');
    fs.renameSync(tmp, absFile);

    // Test verification
    if (config.testCommand) {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(config.testCommand, {
        cwd: workspace, shell: process.env.SHELL ?? '/bin/sh',
        timeout: 120_000, encoding: 'utf8',
      });
      if (result.status !== 0) {
        fs.writeFileSync(absFile, originalContent, 'utf8');
        return { schema_version: 1 as const, status: 'reverted' as const, patch, appliedFiles: [] };
      }
    }

    return { schema_version: 1 as const, status: 'fixed' as const, patch, appliedFiles: [finding.file] };
  });
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | grep -E "fix-finding|pass|fail" | tail -10
```
Expected: all fix-finding tests pass

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-autopilot
git add src/core/mcp/handlers/fix-finding.ts tests/mcp/handlers/fix-finding.test.ts
git commit -m "feat(mcp): fix_finding handler with checksum validation and write lock"
```

---

### Task 10: MCP Server Entry Point + CLI Dispatch + Package

**Files:**
- Create: `src/cli/mcp.ts`
- Modify: `src/cli/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Install @modelcontextprotocol/sdk**

```bash
cd /tmp/claude-autopilot
npm install @modelcontextprotocol/sdk
```

Verify it appears in package.json dependencies:
```bash
grep modelcontextprotocol package.json
```
Expected: `"@modelcontextprotocol/sdk": "^1.29.0"` (or current version)

- [ ] **Step 2: Implement src/cli/mcp.ts**

```typescript
// src/cli/mcp.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../core/config/loader.ts';
import { loadAdapter } from '../adapters/loader.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { handleReviewDiff } from '../core/mcp/handlers/review-diff.ts';
import { handleScanFiles } from '../core/mcp/handlers/scan-files.ts';
import { handleGetFindings } from '../core/mcp/handlers/get-findings.ts';
import { handleFixFinding } from '../core/mcp/handlers/fix-finding.ts';
import { handleValidateFix } from '../core/mcp/handlers/validate-fix.ts';
import { handleGetCapabilities } from '../core/mcp/handlers/get-capabilities.ts';

export async function runMcp(options: { cwd?: string; configPath?: string } = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  const engineRef = (config as { reviewEngine?: unknown }).reviewEngine;
  const ref = typeof engineRef === 'string' ? engineRef : (engineRef as { adapter?: string })?.adapter ?? 'auto';
  const engineOptions = typeof engineRef === 'object' && engineRef !== null
    ? (engineRef as { options?: Record<string, unknown> }).options
    : undefined;

  const engine = await loadAdapter<ReviewEngine>({ point: 'review-engine', ref, options: engineOptions });
  const adapterName = engine.name;

  const server = new Server(
    { name: 'guardrail', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'review_diff',
        description: 'Review git-changed files against a base ref. Returns structured findings with file, line, severity, and suggestion.',
        inputSchema: {
          type: 'object',
          properties: {
            base: { type: 'string', description: 'Base ref to diff against (default: upstream or HEAD~1)' },
            cwd: { type: 'string', description: 'Working directory (default: process.cwd())' },
            static_only: { type: 'boolean', description: 'Skip LLM review, run static rules only (default: false)' },
          },
        },
      },
      {
        name: 'scan_files',
        description: 'Review specific files or directories. Does not require git changes.',
        inputSchema: {
          type: 'object',
          required: ['files'],
          properties: {
            files: { type: 'array', items: { type: 'string' }, description: 'File or directory paths to scan' },
            cwd: { type: 'string' },
            ask: { type: 'string', description: 'Targeted question, e.g. "is there SQL injection risk?"' },
          },
        },
      },
      {
        name: 'get_findings',
        description: 'Return findings from a prior review_diff or scan_files run by run_id.',
        inputSchema: {
          type: 'object',
          required: ['run_id'],
          properties: {
            run_id: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'warning', 'note'], description: 'Minimum severity to include' },
            cwd: { type: 'string' },
          },
        },
      },
      {
        name: 'fix_finding',
        description: 'Apply an LLM-generated fix for a specific finding. Validates file checksum before applying.',
        inputSchema: {
          type: 'object',
          required: ['run_id', 'finding_id'],
          properties: {
            run_id: { type: 'string' },
            finding_id: { type: 'string' },
            cwd: { type: 'string' },
            dry_run: { type: 'boolean', description: 'Return patch without applying (default: false)' },
          },
        },
      },
      {
        name: 'validate_fix',
        description: 'Run the configured testCommand and return structured pass/fail. No-ops if testCommand not configured.',
        inputSchema: {
          type: 'object',
          properties: {
            cwd: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      {
        name: 'get_capabilities',
        description: 'Return adapter, enabled rules, and workspace metadata for agent planning.',
        inputSchema: {
          type: 'object',
          properties: { cwd: { type: 'string' } },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const a = args as Record<string, unknown>;

    try {
      let result: unknown;

      switch (name) {
        case 'review_diff':
          result = await handleReviewDiff(
            { base: a['base'] as string | undefined, cwd: a['cwd'] as string | undefined, static_only: a['static_only'] as boolean | undefined },
            config, engine,
          );
          break;

        case 'scan_files':
          result = await handleScanFiles(
            { files: a['files'] as string[], cwd: a['cwd'] as string | undefined, ask: a['ask'] as string | undefined },
            config, engine,
          );
          break;

        case 'get_findings':
          result = await handleGetFindings({
            run_id: a['run_id'] as string,
            severity: a['severity'] as 'critical' | 'warning' | 'note' | undefined,
            cwd: a['cwd'] as string | undefined,
          });
          break;

        case 'fix_finding':
          result = await handleFixFinding(
            { run_id: a['run_id'] as string, finding_id: a['finding_id'] as string, cwd: a['cwd'] as string | undefined, dry_run: a['dry_run'] as boolean | undefined },
            config, engine,
          );
          break;

        case 'validate_fix':
          result = await handleValidateFix(
            { cwd: a['cwd'] as string | undefined, files: a['files'] as string[] | undefined },
            config,
          );
          break;

        case 'get_capabilities':
          result = await handleGetCapabilities({ cwd: a['cwd'] as string | undefined }, config, adapterName);
          break;

        default:
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code ?? 'unknown_error';
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg, code }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until the transport closes (MCP client disconnects)
}
```

- [ ] **Step 3: Add `case 'mcp':` to src/cli/index.ts**

Open `src/cli/index.ts`. Find the section with `case 'worker':`. Add `case 'mcp':` immediately before or after it:

```typescript
  case 'mcp': {
    const { runMcp } = await import('./mcp.ts');
    const config = flag('config');
    await runMcp({ cwd: process.cwd(), configPath: config });
    break;
  }
```

Also add `'mcp'` to the help text / command list if one exists in the file.

- [ ] **Step 4: Run full test suite to confirm nothing broke**

```bash
cd /tmp/claude-autopilot
node scripts/test-runner.mjs 2>&1 | tail -12
```
Expected: all existing tests + all new mcp tests pass, 0 failures

- [ ] **Step 5: Smoke-test the server starts**

```bash
cd /tmp/claude-autopilot
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | timeout 5 npx tsx src/cli/index.ts mcp 2>/dev/null | head -3
```
Expected: JSON response containing `"result"` with `"serverInfo"` or similar (MCP initialize response)

- [ ] **Step 6: Commit**

```bash
cd /tmp/claude-autopilot
git add src/cli/mcp.ts src/cli/index.ts package.json package-lock.json
git commit -m "feat(mcp): guardrail mcp server — stdio transport, 6 tools"
```
