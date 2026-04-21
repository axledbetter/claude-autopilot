# `autopilot setup` Auto-Detect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npx autopilot setup` — zero-prompt project detection, preset selection, config write, hook install.

**Architecture:** Two new files (`detector.ts`, `setup.ts`) + one modification (`index.ts`). No new dependencies.

**Tech Stack:** TypeScript ESM, Node 22, `node:fs`, `node:path`.

---

### Task 1: `src/cli/detector.ts` — project detection

**Files:**
- Create: `src/cli/detector.ts`
- Test: `tests/detector.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/detector.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectProject } from '../src/cli/detector.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-detect-'));
}

describe('detectProject', () => {
  it('detects go from go.mod', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\ngo 1.22\n');
    const r = detectProject(dir);
    assert.equal(r.preset, 'go');
    assert.equal(r.testCommand, 'go test ./...');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects rails from Gemfile', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 7'\n");
    const r = detectProject(dir);
    assert.equal(r.preset, 'rails-postgres');
    assert.equal(r.testCommand, 'bundle exec rails test');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects fastapi from requirements.txt', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'fastapi\nuvicorn\n');
    const r = detectProject(dir);
    assert.equal(r.preset, 'python-fastapi');
    assert.equal(r.testCommand, 'pytest');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects t3 from package.json with @trpc/server', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
      dependencies: { '@trpc/server': '^11', 'next': '^15' },
    }));
    const r = detectProject(dir);
    assert.equal(r.preset, 't3');
    assert.equal(r.testCommand, 'vitest run');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects nextjs-supabase from package.json with next + supabase', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'jest' },
      dependencies: { 'next': '^15', '@supabase/supabase-js': '^2' },
    }));
    const r = detectProject(dir);
    assert.equal(r.preset, 'nextjs-supabase');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('falls back to nextjs-supabase on generic package.json', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'jest' },
      dependencies: { 'express': '^4' },
    }));
    const r = detectProject(dir);
    assert.equal(r.preset, 'nextjs-supabase');
    assert.equal(r.confidence, 'low');
    fs.rmSync(dir, { recursive: true });
  });

  it('falls back on empty dir', () => {
    const dir = makeTmp();
    const r = detectProject(dir);
    assert.equal(r.preset, 'nextjs-supabase');
    assert.equal(r.testCommand, 'npm test');
    assert.equal(r.confidence, 'low');
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha10
node --test --import tsx/esm tests/detector.test.ts 2>&1 | head -20
```

Expected: error — `detectProject` not found.

- [ ] **Step 3: Write `src/cli/detector.ts`**

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DetectionResult {
  preset: string;
  testCommand: string;
  confidence: 'high' | 'low';
  evidence: string;
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function fileContains(filePath: string, needle: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

function nodeTestCommand(cwd: string): string {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const scripts = pkg?.['scripts'] as Record<string, string> | undefined;
  return scripts?.['test'] ?? 'npm test';
}

export function detectProject(cwd: string): DetectionResult {
  // Go
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { preset: 'go', testCommand: 'go test ./...', confidence: 'high', evidence: 'found go.mod' };
  }

  // Rails
  const gemfile = path.join(cwd, 'Gemfile');
  if (fs.existsSync(gemfile) && fileContains(gemfile, 'rails')) {
    return { preset: 'rails-postgres', testCommand: 'bundle exec rails test', confidence: 'high', evidence: "found Gemfile with 'rails'" };
  }

  // FastAPI
  const reqTxt = path.join(cwd, 'requirements.txt');
  const pyproject = path.join(cwd, 'pyproject.toml');
  if ((fs.existsSync(reqTxt) && fileContains(reqTxt, 'fastapi')) ||
      (fs.existsSync(pyproject) && fileContains(pyproject, 'fastapi'))) {
    return { preset: 'python-fastapi', testCommand: 'pytest', confidence: 'high', evidence: 'found fastapi in requirements' };
  }

  // Node — check package.json deps
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    const deps = {
      ...(pkg?.['dependencies'] as Record<string, string> ?? {}),
      ...(pkg?.['devDependencies'] as Record<string, string> ?? {}),
    };
    const testCmd = nodeTestCommand(cwd);

    if ('@trpc/server' in deps) {
      return { preset: 't3', testCommand: testCmd, confidence: 'high', evidence: 'found @trpc/server in package.json' };
    }
    if ('next' in deps && '@supabase/supabase-js' in deps) {
      return { preset: 'nextjs-supabase', testCommand: testCmd, confidence: 'high', evidence: 'found next + @supabase/supabase-js in package.json' };
    }
    if ('next' in deps) {
      return { preset: 'nextjs-supabase', testCommand: testCmd, confidence: 'low', evidence: 'found next in package.json (no supabase detected)' };
    }
    return { preset: 'nextjs-supabase', testCommand: testCmd, confidence: 'low', evidence: 'found package.json (no strong framework signals)' };
  }

  return { preset: 'nextjs-supabase', testCommand: 'npm test', confidence: 'low', evidence: 'no project signals found — using default preset' };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha10
node --test --import tsx/esm tests/detector.test.ts 2>&1
```

Expected: 7 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/cli/detector.ts tests/detector.test.ts
git commit -m "feat(setup): project detector — auto-detect preset from filesystem signals"
```

---

### Task 2: `src/cli/setup.ts` — setup orchestrator

**Files:**
- Create: `src/cli/setup.ts`
- Test: `tests/setup.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/setup.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSetup } from '../src/cli/setup.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-setup-'));
}

// Stub findPresetConfig for tests (preset files aren't at expected path in test env)
// We test the YAML output by checking the written file, mocking the preset content.

describe('runSetup', () => {
  it('writes autopilot.config.yaml with detected testCommand', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\ngo 1.22\n');
    // Create a fake preset file where the real one would be
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'autopilot.config.yaml'), 'configVersion: 1\nreviewEngine: { adapter: codex }\n');
    // Patch process.cwd temporarily
    const origCwd = process.cwd;
    process.cwd = () => dir;
    try {
      await runSetup({ cwd: dir, skipHook: true });
    } finally {
      process.cwd = origCwd;
    }
    const content = fs.readFileSync(path.join(dir, 'autopilot.config.yaml'), 'utf8');
    assert.ok(content.includes('testCommand: "go test ./..."'), `Expected testCommand in output, got:\n${content}`);
    fs.rmSync(dir, { recursive: true });
  });

  it('errors if autopilot.config.yaml already exists (no --force)', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'autopilot.config.yaml'), 'configVersion: 1\n');
    await assert.rejects(
      () => runSetup({ cwd: dir, skipHook: true }),
      /already exists/,
    );
    fs.rmSync(dir, { recursive: true });
  });

  it('overwrites with --force', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'autopilot.config.yaml'), 'configVersion: 1\n');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\ngo 1.22\n');
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'autopilot.config.yaml'), 'configVersion: 1\n');
    const origCwd = process.cwd;
    process.cwd = () => dir;
    try {
      await runSetup({ cwd: dir, force: true, skipHook: true });
    } finally {
      process.cwd = origCwd;
    }
    const content = fs.readFileSync(path.join(dir, 'autopilot.config.yaml'), 'utf8');
    assert.ok(content.includes('testCommand:'));
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test --import tsx/esm tests/setup.test.ts 2>&1 | head -10
```

Expected: error — `runSetup` not found.

- [ ] **Step 3: Write `src/cli/setup.ts`**

Reuse `findPresetConfig` / `presetSearchPaths` from `init.ts` — import them (they need to be exported first; if not, copy the logic).

```typescript
import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import { detectProject } from './detector.ts';
import { runHook } from './hook.ts';

const PASS = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';

const PRESET_LABELS: Record<string, string> = {
  'nextjs-supabase': 'Next.js + Supabase',
  't3': 'T3 Stack (Next.js + tRPC + Prisma)',
  'rails-postgres': 'Ruby on Rails + PostgreSQL',
  'python-fastapi': 'Python FastAPI',
  'go': 'Go + PostgreSQL',
};

export interface SetupOptions {
  cwd?: string;
  force?: boolean;
  skipHook?: boolean;
}

function presetSearchPaths(name: string, cwd: string): string[] {
  return [
    path.join(cwd, 'node_modules', '@delegance', 'claude-autopilot', 'presets', name, 'autopilot.config.yaml'),
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'presets', name, 'autopilot.config.yaml'),
  ];
}

function findPresetConfig(name: string, cwd: string): string | null {
  for (const p of presetSearchPaths(name, cwd)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const dest = path.join(cwd, 'autopilot.config.yaml');

  if (fs.existsSync(dest) && !options.force) {
    throw new Error('autopilot.config.yaml already exists — use --force to overwrite');
  }

  console.log('\n[setup] Detecting project type...');

  const detection = detectProject(cwd);
  const label = PRESET_LABELS[detection.preset] ?? detection.preset;

  if (detection.confidence === 'high') {
    console.log(`  ${PASS}  ${label} (${detection.evidence})`);
  } else {
    console.log(`  ${WARN}  ${label} — no strong signals found, defaulted to ${detection.preset}`);
    console.log(`       \x1b[2mEdit autopilot.config.yaml to switch presets if needed\x1b[0m`);
  }
  console.log(`  ${PASS}  Test command: ${detection.testCommand}`);

  const presetConfigPath = findPresetConfig(detection.preset, cwd);
  if (!presetConfigPath) {
    throw new Error(`Preset config not found for: ${detection.preset}. Looked in:\n  ${presetSearchPaths(detection.preset, cwd).join('\n  ')}`);
  }

  let presetContent = await fsAsync.readFile(presetConfigPath, 'utf8');
  presetContent = presetContent.trimEnd() + `\ntestCommand: "${detection.testCommand}"\n`;
  await fsAsync.writeFile(dest, presetContent, 'utf8');
  console.log(`  ${PASS}  Created autopilot.config.yaml`);

  if (!options.skipHook) {
    const hookCode = await runHook('install', { cwd });
    if (hookCode === 0) {
      console.log(`  ${PASS}  Installed pre-push git hook`);
    } else {
      console.log(`  ${WARN}  Hook install failed (not fatal — run: npx autopilot hook install)`);
    }
  }

  console.log('\n[setup] Done. Run: npx autopilot run\n');
}
```

- [ ] **Step 4: Check that `runHook` signature is compatible**

Read `src/cli/hook.ts` to verify `runHook('install', { cwd })` returns `Promise<number>`. If the signature differs, adjust the call.

- [ ] **Step 5: Run setup tests**

```bash
node --test --import tsx/esm tests/setup.test.ts 2>&1
```

Expected: 3 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add src/cli/setup.ts tests/setup.test.ts
git commit -m "feat(setup): zero-prompt setup orchestrator"
```

---

### Task 3: Wire `setup` into CLI + export `presetSearchPaths` from `init.ts`

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Read `src/cli/index.ts`** — find the `switch` block and `SUBCOMMANDS` array

- [ ] **Step 2: Add `'setup'` to `SUBCOMMANDS` and add a case**

In the imports section, add:
```typescript
import { runSetup } from './setup.ts';
```

In SUBCOMMANDS, add `'setup'`.

In the switch, add:
```typescript
case 'setup': {
  const force = args.includes('--force');
  await runSetup({ force });
  break;
}
```

- [ ] **Step 3: Run full test suite**

```bash
cd /tmp/claude-autopilot/.worktrees/v1-alpha10
npm test 2>&1 | tail -8
```

Expected: all existing tests pass + new detector + setup tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(setup): wire autopilot setup command into CLI"
```

---

### Task 4: Update README + version to 1.1.0

**Files:**
- Modify: `README.md`
- Modify: `package.json` — bump to `1.1.0`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: In README, update Quick Start section**

Replace the current Quick Start block with:

```markdown
## Quick Start

```bash
# One command — auto-detects project type, writes config, installs hook
npx autopilot setup

# Then run your first pipeline
npx autopilot run
```

Requires Node 22+, `gh` CLI authenticated, `claude` CLI (Claude Code).
```

- [ ] **Step 2: Add `setup` to the Commands table/section in README**

Find where other commands are documented and add:

```
npx autopilot setup            # Auto-detect project, write config, install hook
npx autopilot setup --force    # Overwrite existing autopilot.config.yaml
```

- [ ] **Step 3: Bump version and add CHANGELOG entry**

In `package.json`: `"version": "1.1.0"`

Prepend to `CHANGELOG.md`:

```markdown
## [1.1.0] — 2026-04-21

### Added
- `autopilot setup` — zero-prompt setup: auto-detects project type (Go, Rails, FastAPI, T3, Next.js+Supabase), infers test command, writes config, installs git hook in one command
```

- [ ] **Step 4: Commit**

```bash
git add README.md package.json CHANGELOG.md
git commit -m "docs: document autopilot setup, bump version to 1.1.0"
```
