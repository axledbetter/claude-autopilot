#!/usr/bin/env node
// scripts/autoregress.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectSnapshots } from '../src/snapshots/impact-selector.ts';
import OpenAI from 'openai';
import { buildImportMap } from '../src/snapshots/import-scanner.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAPSHOTS_DIR = path.join(ROOT, 'tests', 'snapshots');
const INDEX_PATH = path.join(SNAPSHOTS_DIR, 'index.json');
const IMPORT_MAP_PATH = path.join(SNAPSHOTS_DIR, 'import-map.json');
const BASELINES_DIR = path.join(SNAPSHOTS_DIR, 'baselines');

function loadJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return fallback; }
}

export function diffBaselines(baselineJson: string, currentJson: string): string[] {
  if (baselineJson === currentJson) return [];
  const baselineLines = baselineJson.split('\n');
  const currentLines = currentJson.split('\n');
  const lines: string[] = [];
  const maxLen = Math.max(baselineLines.length, currentLines.length);
  for (let i = 0; i < maxLen; i++) {
    const bLine = baselineLines[i];
    const cLine = currentLines[i];
    if (bLine === cLine) continue;
    if (bLine !== undefined) lines.push(`- ${bLine}`);
    if (cLine !== undefined) lines.push(`+ ${cLine}`);
  }
  return lines;
}

function getChangedFiles(since?: string): string[] | null {
  try {
    const base = since
      ? since
      : execSync('git merge-base origin/main HEAD', { cwd: ROOT }).toString().trim();
    const out = execSync(`git diff ${base} HEAD --name-only`, { cwd: ROOT }).toString();
    return out.trim().split('\n').filter(Boolean);
  } catch { return null; }
}

function allSnapFiles(): string[] {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  return fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.endsWith('.snap.ts'))
    .map(f => path.join('tests', 'snapshots', f));
}

function runSnapshot(snapFile: string, capture: boolean): 'pass' | 'fail' | 'baseline-missing' | 'stale' {
  const absSnap = path.join(ROOT, snapFile);
  const content = fs.readFileSync(absSnap, 'utf8');
  const forMatch = content.match(/@snapshot-for:\s*(.+)/);
  if (forMatch) {
    const src = forMatch[1]!.trim();
    if (!fs.existsSync(path.join(ROOT, src))) {
      console.warn(`  [warn] stale — source gone: ${src}`);
      return 'stale';
    }
  }

  const slug = path.basename(snapFile, '.snap.ts');
  const baselinePath = path.join(BASELINES_DIR, `${slug}.json`);
  if (!capture && !fs.existsSync(baselinePath)) {
    console.error(`  [fail] baseline missing: ${baselinePath}`);
    return 'baseline-missing';
  }

  const env = { ...process.env };
  if (capture) env.CAPTURE_BASELINE = '1';
  else delete env.CAPTURE_BASELINE;

  const result = spawnSync('node', ['--test', '--import', 'tsx', absSnap], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
    env,
  });

  if (result.status === 0) return 'pass';
  if (capture) return 'pass';
  console.error(`    ${(result.stderr?.toString() ?? '') || (result.stdout?.toString() ?? '')}`);
  return 'fail';
}

function cmdRun(args: string[]): number {
  const runAll = args.includes('--all');
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const index = loadJson<Record<string, string[]>>(INDEX_PATH, {});
  const importMap = loadJson<Record<string, string[]>>(IMPORT_MAP_PATH, {});
  const snapFiles = allSnapFiles();

  let selected: string[];
  if (runAll || snapFiles.length === 0) {
    selected = snapFiles;
    console.log(`[autoregress run] --all: running ${snapFiles.length} snapshot(s)`);
  } else {
    const changed = getChangedFiles(since);
    if (!changed) {
      console.warn('[autoregress run] merge-base resolution failed — running all');
      selected = snapFiles;
    } else {
      const r = selectSnapshots(changed, snapFiles, index, importMap);
      selected = r.selected;
      console.log(`[autoregress run] ${r.reason} (${selected.length}/${snapFiles.length})`);
    }
  }

  if (selected.length === 0) {
    console.log('[autoregress run] no snapshots to run — pass');
    return 0;
  }

  let passed = 0, failed = 0, missing = 0, stale = 0;
  for (const snap of selected) {
    process.stdout.write(`  ${snap} ... `);
    const v = runSnapshot(snap, false);
    if (v === 'pass') { passed++; console.log('pass'); }
    else if (v === 'fail') { failed++; console.log('FAIL'); }
    else if (v === 'baseline-missing') { missing++; console.log('BASELINE MISSING'); }
    else { stale++; console.log('stale (skipped)'); }
  }
  console.log(`\n  ${passed} passed  ${failed} failed  ${missing} baseline-missing  ${stale} stale`);
  return failed > 0 || missing > 0 ? 1 : 0;
}

function cmdUpdate(args: string[]): number {
  const snapIdx = args.indexOf('--snapshot');
  const slug = snapIdx >= 0 ? args[snapIdx + 1] : undefined;
  const snapFiles = slug
    ? [path.join('tests', 'snapshots', `${slug}.snap.ts`)]
    : allSnapFiles();
  console.log(`[autoregress update] rewriting ${snapFiles.length} baseline(s)`);
  let failed = 0;
  for (const snap of snapFiles) {
    const absSnap = path.join(ROOT, snap);
    if (!fs.existsSync(absSnap)) {
      console.error(`  [error] snapshot file not found: ${snap}`);
      failed++;
      continue;
    }
    process.stdout.write(`  ${snap} ... `);
    runSnapshot(snap, true);
    console.log('updated');
  }
  return failed > 0 ? 1 : 0;
}

const GENERATOR_VERSION = '1.0.0-alpha.6';

const GENERATE_PROMPT = `You are generating a behavioral snapshot test for a TypeScript module.

Module path: {filePath}
Module contents:
{fileContents}

Write a snapshot test file. Requirements:
1. Header comments at top:
   // @snapshot-for: {filePath}
   // @generated-at: {generatedAt}
   // @source-commit: {sourceCommit}
   // @generator-version: {version}
2. Import the module's exported functions under test
3. Import { normalizeSnapshot } from '../../src/snapshots/serializer.ts'
4. Import fs from 'node:fs', describe/it from 'node:test', assert from 'node:assert/strict'
5. Baseline loading pattern (use slug {slug}):
   const SLUG = '{slug}';
   import { fileURLToPath } from 'node:url';
   import * as path from 'node:path';
   const baselineRaw = process.env.CAPTURE_BASELINE === '1' ? '{}' : fs.readFileSync(fileURLToPath(new URL('./baselines/{slug}.json', import.meta.url)), 'utf8');
   const baseline = JSON.parse(baselineRaw);
   const captured: Record<string, unknown> = {};
   process.on('exit', () => {
     if (process.env.CAPTURE_BASELINE === '1') {
       const p = process.env.AUTOREGRESS_TEMP_BASELINE_DIR
         ? path.join(process.env.AUTOREGRESS_TEMP_BASELINE_DIR, '{slug}.json')
         : fileURLToPath(new URL('./baselines/{slug}.json', import.meta.url));
       fs.writeFileSync(p, JSON.stringify(captured, null, 2), 'utf8');
     }
   });
6. In each test: if (process.env.CAPTURE_BASELINE === '1') { captured['test-name'] = result; return; }
   Else: assert.equal(normalizeSnapshot(result), normalizeSnapshot(baseline['test-name']));
7. Write 2-4 it() tests covering representative behaviors
8. Output ONLY the TypeScript file contents, no markdown fences, no explanation`;

async function cmdGenerate(args: string[]): Promise<number> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error('[autoregress generate] OPENAI_API_KEY not set'); return 1; }

  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const filesIdx = args.indexOf('--files');
  const filesArg = filesIdx >= 0 ? args[filesIdx + 1] : undefined;

  let srcFiles: string[];
  if (filesArg) {
    srcFiles = filesArg.split(',').map(f => f.trim()).filter(f => f.startsWith('src/') && f.endsWith('.ts'));
    if (srcFiles.length === 0) {
      console.error('[autoregress generate] --files must contain at least one src/*.ts path');
      return 1;
    }
  } else {
    const changed = getChangedFiles(since);
    if (!changed) { console.error('[autoregress generate] could not determine changed files'); return 1; }
    srcFiles = changed.filter(f => f.startsWith('src/') && f.endsWith('.ts'));
    if (srcFiles.length === 0) {
      console.log('[autoregress generate] no src/*.ts files changed — nothing to generate');
      return 0;
    }
  }

  console.log(`[autoregress generate] generating snapshots for ${srcFiles.length} file(s)`);

  const client = new OpenAI({ apiKey });
  let sourceCommit = 'unknown';
  try { sourceCommit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch {}
  const generatedAt = new Date().toISOString();

  for (const srcFile of srcFiles) {
    const absFile = path.join(ROOT, srcFile);
    if (!fs.existsSync(absFile)) { console.warn(`  skip (not found): ${srcFile}`); continue; }

    const fileContents = fs.readFileSync(absFile, 'utf8');
    const slug = srcFile.replace(/[/\\]/g, '-').replace(/\.ts$/, '');

    process.stdout.write(`  ${srcFile} → ${slug}.snap.ts ... `);

    const prompt = GENERATE_PROMPT
      .replace(/{filePath}/g, srcFile)
      .replace(/{fileContents}/g, fileContents)
      .replace(/{slug}/g, slug)
      .replace(/{version}/g, GENERATOR_VERSION)
      .replace(/{generatedAt}/g, generatedAt)
      .replace(/{sourceCommit}/g, sourceCommit);

    let snapContent: string;
    try {
      const response = await client.responses.create({
        model: process.env.CODEX_MODEL ?? 'gpt-5.3-codex',
        instructions: 'You write TypeScript snapshot tests. Output ONLY the file contents, no markdown fences.',
        input: prompt,
        max_output_tokens: 2000,
      });
      snapContent = (response.output_text ?? '').replace(/^```typescript\n?/m, '').replace(/```$/m, '').trim();
    } catch (err) {
      console.error(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const snapPath = path.join(SNAPSHOTS_DIR, `${slug}.snap.ts`);
    fs.writeFileSync(snapPath, snapContent + '\n', 'utf8');

    const captureResult = spawnSync('node', ['--test', '--import', 'tsx', snapPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
      env: { ...process.env, CAPTURE_BASELINE: '1' },
    });
    const baselinePath = path.join(BASELINES_DIR, `${slug}.json`);
    console.log(fs.existsSync(baselinePath) ? 'generated + baseline captured' :
      `generated (capture failed: ${captureResult.stderr?.toString().slice(0, 60)})`);
  }

  // Rebuild index.json from @snapshot-for headers
  const newIndex: Record<string, string[]> = {};
  for (const f of fs.readdirSync(SNAPSHOTS_DIR).filter(x => x.endsWith('.snap.ts'))) {
    const snapRelPath = path.join('tests', 'snapshots', f);
    const content = fs.readFileSync(path.join(SNAPSHOTS_DIR, f), 'utf8');
    const sources = [...content.matchAll(/@snapshot-for:\s*(.+)/g)].map(m => m[1]!.trim());
    if (sources.length) newIndex[snapRelPath] = sources;
  }
  fs.writeFileSync(INDEX_PATH, JSON.stringify(newIndex, null, 2) + '\n', 'utf8');

  // Rebuild import-map.json — prefix keys/values with 'src/' to match repo-relative git diff paths
  const rawImportMap = buildImportMap(path.join(ROOT, 'src'));
  const newImportMap: Record<string, string[]> = {};
  for (const [dep, importers] of Object.entries(rawImportMap)) {
    newImportMap[`src/${dep}`] = importers.map(i => `src/${i}`);
  }
  fs.writeFileSync(IMPORT_MAP_PATH, JSON.stringify(newImportMap, null, 2) + '\n', 'utf8');

  console.log('\n[autoregress generate] index.json + import-map.json rebuilt');
  return 0;
}

function cmdDiff(args: string[]): number {
  const runAll = args.includes('--all');
  const snapIdx = args.indexOf('--snapshot');
  const slug = snapIdx >= 0 ? args[snapIdx + 1] : undefined;
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;

  const index = loadJson<Record<string, string[]>>(INDEX_PATH, {});
  const importMap = loadJson<Record<string, string[]>>(IMPORT_MAP_PATH, {});
  const snapFiles = slug
    ? [path.join('tests', 'snapshots', `${slug}.snap.ts`)]
    : allSnapFiles();

  let selected: string[];
  if (runAll || slug || snapFiles.length === 0) {
    selected = snapFiles;
  } else {
    const changed = getChangedFiles(since);
    selected = changed ? selectSnapshots(changed, snapFiles, index, importMap).selected : snapFiles;
  }

  if (selected.length === 0) {
    console.log('[autoregress diff] no snapshots to diff');
    return 0;
  }

  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const red = useColor ? '\x1b[31m' : '';
  const green = useColor ? '\x1b[32m' : '';
  const reset = useColor ? '\x1b[0m' : '';

  let changedCount = 0;
  for (const snap of selected) {
    const slug_ = path.basename(snap, '.snap.ts');
    const baselinePath = path.join(BASELINES_DIR, `${slug_}.json`);

    if (!fs.existsSync(baselinePath)) {
      console.log(`  ${snap} — ${red}no baseline${reset}`);
      continue;
    }

    const tmpBaselinesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-diff-'));
    const tmpBaselinePath = path.join(tmpBaselinesDir, `${slug_}.json`);
    fs.copyFileSync(baselinePath, tmpBaselinePath);

    const absSnap = path.join(ROOT, snap);
    const captureResult = spawnSync('node', ['--test', '--import', 'tsx', absSnap], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
      env: { ...process.env, CAPTURE_BASELINE: '1', AUTOREGRESS_TEMP_BASELINE_DIR: tmpBaselinesDir },
    });

    const baselineJson = fs.readFileSync(baselinePath, 'utf8');
    const captureOk = fs.existsSync(tmpBaselinePath);
    const currentJson = captureOk ? fs.readFileSync(tmpBaselinePath, 'utf8') : null;
    if (!captureOk && captureResult.status !== 0) {
      const stderr = captureResult.stderr?.toString().trim();
      if (stderr) console.error(`    ${stderr.slice(0, 120)}`);
    }
    fs.rmSync(tmpBaselinesDir, { recursive: true, force: true });

    if (!currentJson) {
      console.log(`  ${snap} — ${red}capture failed${reset}`);
      continue;
    }

    const diffLines = diffBaselines(baselineJson, currentJson);
    if (diffLines.length === 0) {
      console.log(`  ${snap} — ${green}✓ no changes${reset}`);
    } else {
      changedCount++;
      console.log(`  ${snap}`);
      for (const line of diffLines) {
        if (line.startsWith('-')) console.log(`    ${red}${line}${reset}`);
        else if (line.startsWith('+')) console.log(`    ${green}${line}${reset}`);
        else console.log(`    ${line}`);
      }
    }
  }

  return changedCount > 0 ? 1 : 0;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  const [,, subcmd, ...rest] = process.argv;
  switch (subcmd) {
    case 'run': process.exit(cmdRun(rest)); break;
    case 'update': process.exit(cmdUpdate(rest)); break;
    case 'generate': process.exit(await cmdGenerate(rest)); break;
    case 'diff': process.exit(cmdDiff(rest)); break;
    default:
      console.error(`[autoregress] unknown subcommand: ${subcmd ?? '(none)'}`);
      process.exit(1);
  }
}
