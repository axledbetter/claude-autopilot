// v7.4.0 — Node ESM scaffolder, extracted from src/cli/scaffold.ts (was the
// monolithic v7.2.0 implementation). Pure module split: the buildStarterPackageJson
// + scaffoldNode functions here are byte-identical-in-behavior to v7.2.0; the
// existing 11 scaffold tests are the regression bar.
//
// Why split: v7.4.0 adds Python + FastAPI per-stack scaffolders (see ./python.ts).
// Keeping each stack in its own module makes the v7.5+ plan (Go, Rust, Ruby) a
// drop-in pattern: add a new file, register it in the dispatcher inside
// ../scaffold.ts.

import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';

import type { ParsedFiles, ScaffoldResult, ScaffoldRunContext } from './types.ts';

const PASS = '\x1b[32m✓\x1b[0m';
const SKIP = '\x1b[2m·\x1b[0m';
const DIM  = (t: string) => `\x1b[2m${t}\x1b[0m`;

/**
 * Build a minimal starter package.json. Caller passes in any explicit
 * hints (parsed from spec); we layer Node 22 ESM defaults on top.
 *
 * Note: signature unchanged from v7.2.0 — re-exported through ../scaffold.ts
 * so consumers that imported from the public scaffold module keep working.
 */
export function buildStarterPackageJson(
  projectName: string,
  hints: ParsedFiles['packageHints'],
): Record<string, unknown> {
  const pkg: Record<string, unknown> = {
    name: projectName,
    version: '0.1.0',
    private: true,
    type: hints.type ?? 'module',
    engines: { node: '>=22' },
    scripts: {
      test: 'node --test tests/*.test.js',
      ...hints.scripts,
    },
  };
  if (hints.bin) pkg.bin = hints.bin;
  if (hints.dependencies) pkg.dependencies = hints.dependencies;
  if (hints.devDependencies) pkg.devDependencies = hints.devDependencies;
  return pkg;
}

const STARTER_TSCONFIG_JS = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    types: ['node'],
  },
  include: ['bin/**/*', 'src/**/*', 'tests/**/*'],
};

const STARTER_TSCONFIG_TS = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    outDir: 'dist',
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    types: ['node'],
  },
  include: ['bin/**/*', 'src/**/*', 'tests/**/*'],
};

/**
 * Node ESM scaffolder. Materializes directories + placeholder files,
 * writes package.json (when listed in spec) and tsconfig.json (when listed),
 * choosing JS vs TS tsconfig flavor based on which extension dominates the
 * other listed paths.
 *
 * Behavior is intentionally byte-identical to v7.2.0 — the existing
 * tests/scaffold.test.ts is the regression bar.
 */
export async function scaffoldNode(ctx: ScaffoldRunContext): Promise<ScaffoldResult> {
  const { cwd, parsed, dryRun } = ctx;
  const projectName = path.basename(cwd);
  const filesCreated: string[] = [];
  const filesSkippedExisting: string[] = [];
  const dirsCreated: string[] = [];
  let packageJsonAction: ScaffoldResult['packageJsonAction'] = 'skipped-exists';
  let tsconfigAction: ScaffoldResult['tsconfigAction'] = 'skipped-no-ts';

  // 1) Create directories first.
  const dirs = new Set<string>();
  for (const p of parsed.paths) {
    const d = path.dirname(p);
    if (d && d !== '.') dirs.add(d);
  }
  for (const d of dirs) {
    const abs = path.join(cwd, d);
    if (fs.existsSync(abs)) continue;
    if (!dryRun) await fsAsync.mkdir(abs, { recursive: true });
    dirsCreated.push(d);
    console.log(`  ${PASS}  mkdir   ${DIM(d + '/')}`);
  }

  // 2) Create placeholder files (skip ones we'll handle specially).
  const SPECIAL = new Set(['package.json', 'tsconfig.json']);
  for (const p of parsed.paths) {
    if (SPECIAL.has(p)) continue;
    const abs = path.join(cwd, p);
    if (fs.existsSync(abs)) {
      filesSkippedExisting.push(p);
      console.log(`  ${SKIP}  exists  ${DIM(p)}`);
      continue;
    }
    if (!dryRun) {
      await fsAsync.mkdir(path.dirname(abs), { recursive: true });
      // Touch — empty file. Real content is the agent's job.
      await fsAsync.writeFile(abs, '', 'utf8');
    }
    filesCreated.push(p);
    console.log(`  ${PASS}  touch   ${DIM(p)}`);
  }

  // 3) package.json — only if the spec lists it.
  if (parsed.paths.includes('package.json')) {
    const pkgAbs = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgAbs)) {
      packageJsonAction = 'skipped-exists';
      console.log(`  ${SKIP}  exists  ${DIM('package.json (preserved)')}`);
    } else {
      const pkg = buildStarterPackageJson(projectName, parsed.packageHints);
      if (!dryRun) {
        await fsAsync.writeFile(pkgAbs, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      }
      packageJsonAction = 'created';
      console.log(`  ${PASS}  write   ${DIM('package.json (Node 22 ESM starter)')}`);
    }
  }

  // 4) tsconfig.json — only if the spec lists it. JS-flavor when the
  //    other paths are predominantly .js, TS-flavor for .ts.
  if (parsed.paths.includes('tsconfig.json')) {
    const tsAbs = path.join(cwd, 'tsconfig.json');
    if (fs.existsSync(tsAbs)) {
      tsconfigAction = 'skipped-exists';
      console.log(`  ${SKIP}  exists  ${DIM('tsconfig.json (preserved)')}`);
    } else {
      const otherPaths = parsed.paths.filter((p) => !SPECIAL.has(p));
      const tsCount = otherPaths.filter((p) => /\.tsx?$/.test(p)).length;
      const jsCount = otherPaths.filter((p) => /\.jsx?$/.test(p)).length;
      const config = tsCount > jsCount ? STARTER_TSCONFIG_TS : STARTER_TSCONFIG_JS;
      tsconfigAction = 'created';
      if (!dryRun) {
        await fsAsync.writeFile(tsAbs, JSON.stringify(config, null, 2) + '\n', 'utf8');
      }
      const flavor = config === STARTER_TSCONFIG_TS ? 'compiled TS to dist/' : 'JS w/ JSDoc + checkJs';
      console.log(`  ${PASS}  write   ${DIM(`tsconfig.json (${flavor})`)}`);
    }
  }

  return { filesCreated, dirsCreated, filesSkippedExisting, packageJsonAction, tsconfigAction };
}
