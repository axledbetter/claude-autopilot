# alpha.5 — SARIF Output + GitHub Actions Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--format sarif --output <path>` to `autopilot run`, auto-emit GitHub Actions workflow command annotations, and ship a composite `action.yml` that wires SARIF code scanning + inline PR annotations with zero user config.

**Architecture:** Two pure formatter modules (`sarif.ts`, `github-annotations.ts`) with no new runtime deps. `run.ts` calls them after `runAutopilot()`. `action.yml` at repo root is a composite action using `npx --package` — no bundling required.

**Tech Stack:** Node 22 ESM TypeScript, SARIF 2.1.0 (inline types), GitHub Actions composite action, `github/codeql-action/upload-sarif@v3`.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/formatters/sarif.ts` | Create | `toSarif()` + `normalizeSarifUri()` — pure RunResult → SARIF 2.1.0 |
| `src/formatters/github-annotations.ts` | Create | `emitAnnotations()` + encode helpers — pure Finding[] → stdout workflow commands |
| `src/formatters/index.ts` | Create | Re-export barrel |
| `src/cli/run.ts` | Modify | Add `format`/`outputPath` options, SARIF write, auto-annotation call |
| `src/cli/index.ts` | Modify | Add `--format` and `--output` flag parsing + validation |
| `action.yml` | Create | Composite GitHub Action at repo root |
| `tests/formatters/sarif.test.ts` | Create | 11 SARIF tests |
| `tests/formatters/github-annotations.test.ts` | Create | 8 annotation tests |
| `package.json` | Modify | Bump to `1.0.0-alpha.5` |
| `CHANGELOG.md` | Modify | Add alpha.5 entry |

---

## Task 1: SARIF Formatter

**Files:**
- Create: `src/formatters/sarif.ts`
- Create: `tests/formatters/sarif.test.ts`

- [ ] **Step 1: Write all 11 failing SARIF tests**

```typescript
// tests/formatters/sarif.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toSarif, normalizeSarifUri } from '../../src/formatters/sarif.ts';
import type { RunResult } from '../../src/core/pipeline/run.ts';
import type { Finding } from '../../src/core/findings/types.ts';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'static-rules',
    severity: 'warning',
    category: 'test-rule',
    file: 'src/foo.ts',
    message: 'something wrong',
    protectedPath: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeResult(findings: Finding[] = []): RunResult {
  return { status: 'pass', phases: [], allFindings: findings, durationMs: 100 };
}

const OPTS = { toolVersion: '1.0.0-test', cwd: '/repo' };

describe('toSarif', () => {
  it('S1: empty findings → valid SARIF with results: []', () => {
    const log = toSarif(makeResult([]), OPTS);
    assert.equal(log.version, '2.1.0');
    assert.equal(log.$schema, 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json');
    assert.equal(log.runs.length, 1);
    assert.deepEqual(log.runs[0]!.results, []);
    assert.deepEqual(log.runs[0]!.tool.driver.rules, []);
  });

  it('S2: critical → level "error"', () => {
    const log = toSarif(makeResult([makeFinding({ severity: 'critical' })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.level, 'error');
  });

  it('S3: warning → level "warning"', () => {
    const log = toSarif(makeResult([makeFinding({ severity: 'warning' })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.level, 'warning');
  });

  it('S4: note → level "note"', () => {
    const log = toSarif(makeResult([makeFinding({ severity: 'note' })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.level, 'note');
  });

  it('S5: finding with line → region.startLine set', () => {
    const log = toSarif(makeResult([makeFinding({ line: 42 })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.locations[0]!.physicalLocation.region?.startLine, 42);
  });

  it('S6: finding without line → no region property', () => {
    const log = toSarif(makeResult([makeFinding({ line: undefined })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.locations[0]!.physicalLocation.region, undefined);
  });

  it('S7: two findings same category → one rule in driver.rules', () => {
    const findings = [
      makeFinding({ id: 'f1', category: 'dupe-rule' }),
      makeFinding({ id: 'f2', category: 'dupe-rule' }),
    ];
    const log = toSarif(makeResult(findings), OPTS);
    assert.equal(log.runs[0]!.tool.driver.rules.length, 1);
    assert.equal(log.runs[0]!.tool.driver.rules[0]!.id, 'dupe-rule');
  });

  it('S8: suggestion present → fixes[0].description.text', () => {
    const log = toSarif(makeResult([makeFinding({ suggestion: 'use X instead' })]), OPTS);
    assert.equal(log.runs[0]!.results[0]!.fixes?.[0]?.description.text, 'use X instead');
  });

  it('S9: absolute path → repo-relative forward-slash', () => {
    const log = toSarif(makeResult([makeFinding({ file: '/repo/src/foo.ts' })]), OPTS);
    assert.equal(
      log.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri,
      'src/foo.ts',
    );
  });

  it('S10: Windows backslash path → forward-slash', () => {
    assert.equal(normalizeSarifUri('src\\foo\\bar.ts', '/repo'), 'src/foo/bar.ts');
  });

  it('S11: ./prefix → stripped', () => {
    assert.equal(normalizeSarifUri('./src/foo.ts', '/repo'), 'src/foo.ts');
  });
});
```

- [ ] **Step 2: Run tests to verify they all fail**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha5
node --test --import tsx tests/formatters/sarif.test.ts
```

Expected: all 11 fail with `Cannot find module '../../src/formatters/sarif.ts'`

- [ ] **Step 3: Implement `src/formatters/sarif.ts`**

```typescript
// src/formatters/sarif.ts
import * as path from 'node:path';
import type { RunResult } from '../core/pipeline/run.ts';
import type { Finding } from '../core/findings/types.ts';

// SARIF 2.1.0 types (inline — no external deps)
interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}
interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
}
interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}
interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
}
interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: SarifLocation[];
  fixes?: Array<{ description: { text: string } }>;
}
interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region?: { startLine: number };
  };
}

export type { SarifLog };

export function normalizeSarifUri(file: string, cwd: string): string {
  let rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
  rel = rel.replace(/\\/g, '/');
  if (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
}

function severityToLevel(s: Finding['severity']): 'error' | 'warning' | 'note' {
  if (s === 'critical') return 'error';
  if (s === 'warning') return 'warning';
  return 'note';
}

export function toSarif(
  result: RunResult,
  opts: { toolVersion: string; cwd?: string },
): SarifLog {
  const cwd = opts.cwd ?? process.cwd();

  const rulesMap = new Map<string, SarifRule>();
  for (const f of result.allFindings) {
    if (!rulesMap.has(f.category)) {
      rulesMap.set(f.category, {
        id: f.category,
        name: f.category,
        shortDescription: { text: f.category },
      });
    }
  }

  const results: SarifResult[] = result.allFindings.map(f => {
    const r: SarifResult = {
      ruleId: f.category,
      level: severityToLevel(f.severity),
      message: { text: f.message },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: normalizeSarifUri(f.file, cwd), uriBaseId: '%SRCROOT%' },
          ...(f.line !== undefined ? { region: { startLine: f.line } } : {}),
        },
      }],
    };
    if (f.suggestion) r.fixes = [{ description: { text: f.suggestion } }];
    return r;
  });

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'claude-autopilot',
          version: opts.toolVersion,
          informationUri: 'https://github.com/axledbetter/claude-autopilot',
          rules: [...rulesMap.values()],
        },
      },
      results,
    }],
  };
}
```

- [ ] **Step 4: Run tests — verify all 11 pass**

```bash
node --test --import tsx tests/formatters/sarif.test.ts
```

Expected: 11 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/formatters/sarif.ts tests/formatters/sarif.test.ts
git commit -m "feat(formatters): SARIF 2.1.0 formatter with URI normalization"
```

---

## Task 2: GitHub Annotations Formatter

**Files:**
- Create: `src/formatters/github-annotations.ts`
- Create: `tests/formatters/github-annotations.test.ts`

- [ ] **Step 1: Write all 8 failing annotation tests**

```typescript
// tests/formatters/github-annotations.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitAnnotations,
  encodeAnnotationProperty,
  encodeAnnotationData,
} from '../../src/formatters/github-annotations.ts';
import type { Finding } from '../../src/core/findings/types.ts';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'static-rules',
    severity: 'warning',
    category: 'test-rule',
    file: 'src/foo.ts',
    line: 10,
    message: 'test message',
    protectedPath: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown) => { chunks.push(String(chunk)); return true; };
  try { fn(); } finally { process.stdout.write = original; }
  return chunks.join('');
}

describe('emitAnnotations', () => {
  beforeEach(() => { process.env.GITHUB_ACTIONS = 'true'; });
  afterEach(() => { delete process.env.GITHUB_ACTIONS; });

  it('A1: critical → ::error command', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ severity: 'critical' })]));
    assert.ok(out.startsWith('::error '), `expected ::error, got: ${out}`);
  });

  it('A2: warning → ::warning command', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ severity: 'warning' })]));
    assert.ok(out.startsWith('::warning '), `expected ::warning, got: ${out}`);
  });

  it('A3: note → ::notice command', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ severity: 'note' })]));
    assert.ok(out.startsWith('::notice '), `expected ::notice, got: ${out}`);
  });

  it('A4: finding with line → file=...,line=N,endLine=N in props', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ file: 'src/x.ts', line: 7 })]));
    assert.ok(out.includes('file=src/x.ts'), `missing file=: ${out}`);
    assert.ok(out.includes('line=7'), `missing line=7: ${out}`);
    assert.ok(out.includes('endLine=7'), `missing endLine=7: ${out}`);
  });

  it('A5: finding without line → no line= property', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ line: undefined })]));
    assert.ok(!out.includes('line='), `unexpected line= in: ${out}`);
  });

  it('A6: empty findings → no output', () => {
    const out = captureStdout(() => emitAnnotations([]));
    assert.equal(out, '');
  });

  it('A7: message with %, newline, comma → percent-encoded in data', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ message: '100% done\nfix it' })]));
    // The data portion (after final ::) must have % and \n encoded
    const dataStart = out.lastIndexOf('::') + 2;
    const data = out.slice(dataStart);
    assert.ok(data.includes('%25'), `% not encoded: ${data}`);
    assert.ok(data.includes('%0A'), `\\n not encoded: ${data}`);
  });

  it('A8: GITHUB_ACTIONS not set → no output', () => {
    delete process.env.GITHUB_ACTIONS;
    const out = captureStdout(() => emitAnnotations([makeFinding()]));
    assert.equal(out, '');
  });
});

describe('encodeAnnotationProperty', () => {
  it('encodes %, \\r, \\n, :, ,', () => {
    assert.equal(encodeAnnotationProperty('a%b:c,d\r\ne'), 'a%25b%3Ac%2Cd%0D%0Ae');
  });
});

describe('encodeAnnotationData', () => {
  it('encodes %, \\r, \\n but not : or ,', () => {
    assert.equal(encodeAnnotationData('a%b:c,d\r\ne'), 'a%25b:c,d%0D%0Ae');
  });
});
```

- [ ] **Step 2: Run tests — verify all fail**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha5
node --test --import tsx tests/formatters/github-annotations.test.ts
```

Expected: all fail with `Cannot find module '../../src/formatters/github-annotations.ts'`

- [ ] **Step 3: Implement `src/formatters/github-annotations.ts`**

```typescript
// src/formatters/github-annotations.ts
import type { Finding } from '../core/findings/types.ts';

export function encodeAnnotationProperty(s: string): string {
  return s
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

export function encodeAnnotationData(s: string): string {
  return s
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function severityToCommand(s: Finding['severity']): 'error' | 'warning' | 'notice' {
  if (s === 'critical') return 'error';
  if (s === 'warning') return 'warning';
  return 'notice';
}

export function emitAnnotations(findings: Finding[]): void {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  for (const f of findings) {
    const cmd = severityToCommand(f.severity);
    const props: string[] = [`file=${encodeAnnotationProperty(f.file)}`];
    if (f.line !== undefined) {
      props.push(`line=${f.line}`, `endLine=${f.line}`);
    }
    props.push(`title=${encodeAnnotationProperty(f.category)}`);
    process.stdout.write(`::${cmd} ${props.join(',')}::${encodeAnnotationData(f.message)}\n`);
  }
}
```

- [ ] **Step 4: Run tests — verify all 10 pass**

```bash
node --test --import tsx tests/formatters/github-annotations.test.ts
```

Expected: 10 pass, 0 fail

- [ ] **Step 5: Create barrel `src/formatters/index.ts`**

```typescript
// src/formatters/index.ts
export { toSarif, normalizeSarifUri } from './sarif.ts';
export type { SarifLog } from './sarif.ts';
export { emitAnnotations, encodeAnnotationProperty, encodeAnnotationData } from './github-annotations.ts';
```

- [ ] **Step 6: Commit**

```bash
git add src/formatters/github-annotations.ts src/formatters/index.ts tests/formatters/github-annotations.test.ts
git commit -m "feat(formatters): GitHub Actions annotation emitter with command encoding"
```

---

## Task 3: CLI — `--format` / `--output` Flags + SARIF Write + Auto-Annotation

**Files:**
- Modify: `src/cli/run.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Add `format` and `outputPath` to `RunCommandOptions` in `src/cli/run.ts`**

Add two fields to the interface at line 28:

```typescript
export interface RunCommandOptions {
  cwd?: string;
  configPath?: string;
  base?: string;
  files?: string[];
  dryRun?: boolean;
  format?: 'text' | 'sarif';   // ← add
  outputPath?: string;          // ← add
}
```

- [ ] **Step 2: Add version-reading helper and formatter imports at top of `src/cli/run.ts`**

Add after the existing imports (after line 12):

```typescript
import { fileURLToPath } from 'node:url';
import { toSarif } from '../formatters/sarif.ts';
import { emitAnnotations } from '../formatters/github-annotations.ts';

function readToolVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
  return (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}
```

- [ ] **Step 3: Add SARIF write + annotation call after `runAutopilot()` returns in `src/cli/run.ts`**

The current code at line 110 is `const result = await runAutopilot(input);`. Insert the following block immediately after that line (before the phase summary loop at line 112):

```typescript
  // Emit GitHub Actions annotations (always when running in CI)
  if (process.env.GITHUB_ACTIONS === 'true') {
    emitAnnotations(result.allFindings);
  }

  // Write SARIF output file if requested
  if (options.format === 'sarif' && options.outputPath) {
    const sarif = toSarif(result, { toolVersion: readToolVersion(), cwd });
    fs.writeFileSync(options.outputPath, JSON.stringify(sarif, null, 2), 'utf8');
    console.log(fmt('dim', `[run] SARIF written to ${options.outputPath}`));
  }
```

- [ ] **Step 4: Add `--format` and `--output` flag parsing to `src/cli/index.ts`**

In the `case 'run':` block (around line 90), add parsing for the new flags and pass them to `runCommand`:

```typescript
  case 'run': {
    const base = flag('base');
    const config = flag('config');
    const filesArg = flag('files');
    const dryRun = boolFlag('dry-run');
    const format = flag('format') as 'text' | 'sarif' | undefined;
    const outputPath = flag('output');

    if (format && format !== 'text' && format !== 'sarif') {
      console.error(`\x1b[31m[autopilot] --format must be "text" or "sarif"\x1b[0m`);
      process.exit(1);
    }
    if (format === 'sarif' && !outputPath) {
      console.error(`\x1b[31m[autopilot] --format sarif requires --output <path>\x1b[0m`);
      process.exit(1);
    }

    const code = await runCommand({
      base,
      configPath: config,
      files: filesArg ? filesArg.split(',').map(f => f.trim()) : undefined,
      dryRun,
      format,
      outputPath,
    });
    process.exit(code);
    break;
  }
```

- [ ] **Step 5: Update `printUsage()` in `src/cli/index.ts` to document new flags**

Find the `Options (run):` section in `printUsage()` and add:

```
  --format <text|sarif>  Output format (default: text)
  --output <path>        Output file for SARIF (required with --format sarif)
```

- [ ] **Step 6: Run full test suite to verify nothing broke**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha5
node scripts/test-runner.mjs
```

Expected: 95 tests pass (74 existing + 11 SARIF + 10 annotation tests), 0 fail

- [ ] **Step 7: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors

- [ ] **Step 8: Commit**

```bash
git add src/cli/run.ts src/cli/index.ts
git commit -m "feat(cli): --format sarif/--output flags, auto-annotations on GITHUB_ACTIONS"
```

---

## Task 4: `action.yml` Composite Action

**Files:**
- Create: `action.yml` (at repo root)

- [ ] **Step 1: Create `action.yml`**

```yaml
# action.yml
name: Claude Autopilot
description: >
  Run the autopilot pipeline on changed files, upload findings to GitHub Code
  Scanning (SARIF), and annotate the PR diff inline.
author: axledbetter

inputs:
  config:
    description: Path to autopilot.config.yaml
    default: autopilot.config.yaml
  version:
    description: Package version to install (e.g. 1.0.0-alpha.5, latest, alpha)
    default: alpha
  sarif-output:
    description: Path to write SARIF results file
    default: autopilot-results.sarif
  openai-api-key:
    description: OpenAI API key for the review engine. Pass via secrets.
    required: false

runs:
  using: composite
  steps:
    - name: Checkout repository
      uses: actions/checkout@v4

    - name: Set up Node.js 22
      uses: actions/setup-node@v4
      with:
        node-version: '22'
        cache: npm

    - name: Run autopilot pipeline
      run: |
        npx --yes --package @delegance/claude-autopilot@${{ inputs.version }} \
          autopilot run \
          --config "${{ inputs.config }}" \
          --format sarif \
          --output "${{ inputs.sarif-output }}"
      shell: bash
      env:
        OPENAI_API_KEY: ${{ inputs.openai-api-key }}

    - name: Upload SARIF to GitHub Code Scanning
      uses: github/codeql-action/upload-sarif@v3
      if: always()
      with:
        sarif_file: ${{ inputs.sarif-output }}
```

- [ ] **Step 2: Verify YAML is valid**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha5
node --input-type=module <<'EOF'
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
load(readFileSync('action.yml', 'utf8'));
console.log('action.yml is valid YAML');
EOF
```

Expected: prints `action.yml is valid YAML`

- [ ] **Step 3: Commit**

```bash
git add action.yml
git commit -m "feat: composite GitHub Action (SARIF upload + inline PR annotations)"
```

---

## Task 5: Version Bump + CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version in `package.json`**

Change `"version": "1.0.0-alpha.4"` to `"version": "1.0.0-alpha.5"`.

- [ ] **Step 2: Sync package-lock.json**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha5
npm install --package-lock-only
```

- [ ] **Step 3: Prepend alpha.5 entry to `CHANGELOG.md`**

Insert at the top (after the `# Changelog` heading):

```markdown
## 1.0.0-alpha.5 (2026-04-21)

### New Features

- **`--format sarif --output <path>`** on `autopilot run` — serialises `RunResult` to SARIF 2.1.0; deduplicates rules by category; normalises URIs to repo-relative forward-slash; always emits `results: []` even on error so `upload-sarif` never fails on a missing file
- **Auto GitHub Actions annotations** — when `GITHUB_ACTIONS=true`, `emitAnnotations()` fires after every run and writes `::error`/`::warning`/`::notice` workflow commands to stdout; GitHub renders these as inline annotations on the PR diff
- **`src/formatters/`** — pure formatter modules (`sarif.ts`, `github-annotations.ts`) with full command-injection encoding (`%`, `\r`, `\n`, `:`, `,`) for annotation properties and data
- **`action.yml`** composite action — checkout → setup-node@v4 → npx autopilot run → upload-sarif@v3; inputs: `version`, `config`, `sarif-output`, `openai-api-key`; upload step runs `if: always()` so findings surface even when run exits 1
- 21 new formatter tests (11 SARIF + 10 annotations) → **95 total**
```

- [ ] **Step 4: Run full test suite one final time**

```bash
node scripts/test-runner.mjs
```

Expected: 95 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: bump to 1.0.0-alpha.5"
```
