#!/usr/bin/env node
// scripts/autoregress.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectSnapshots } from '../src/snapshots/impact-selector.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAPSHOTS_DIR = path.join(ROOT, 'tests', 'snapshots');
const INDEX_PATH = path.join(SNAPSHOTS_DIR, 'index.json');
const IMPORT_MAP_PATH = path.join(SNAPSHOTS_DIR, 'import-map.json');
const BASELINES_DIR = path.join(SNAPSHOTS_DIR, 'baselines');

function loadJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return fallback; }
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
  for (const snap of snapFiles) {
    process.stdout.write(`  ${snap} ... `);
    runSnapshot(snap, true);
    console.log('updated');
  }
  return 0;
}

const [,, subcmd, ...rest] = process.argv;
switch (subcmd) {
  case 'run': process.exit(cmdRun(rest)); break;
  case 'update': process.exit(cmdUpdate(rest)); break;
  case 'generate':
    console.error('[autoregress] generate not yet implemented in this task');
    process.exit(1);
    break;
  default:
    console.error(`[autoregress] unknown subcommand: ${subcmd ?? '(none)'}`);
    process.exit(1);
}
