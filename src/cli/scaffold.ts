// v7.2.0 — `claude-autopilot scaffold --from-spec <path>`
//
// Closes the biggest remaining day-1 friction the v7.1.6 blank-repo
// benchmark identified: even with auto-scaffolded CLAUDE.md and .gitignore
// (v7.1.7), a fresh repo still needs a hand-written package.json, tsconfig,
// and directory skeleton before any feature work happens. This verb reads
// a spec markdown file's `## Files` section and creates the listed
// directories + a starter package.json + tsconfig.json.
//
// Scope intentionally small:
//   - Node ESM only (one-shot ship; per-stack expansion is v8 work).
//   - Touches files, never overwrites (operator opted into autopilot, not
//     into us nuking their package.json).
//   - Inspects spec for `scripts:` / `dependencies:` / `devDependencies:`
//     hints in plain prose; uses heuristics rather than a strict schema.
//
// Spec format expectations (matches v7.1.6 benchmark spec shape):
//
//   ## Files
//
//   * `package.json` — `type: module`, `bin: { foo: bin/foo.js }`,
//     `dependencies: { @anthropic-ai/sdk: ^0.91 }`, ...
//   * `bin/foo.js` — argv parser + main loop.
//   * `src/baz.js` — pure function.
//   * `tests/foo.test.js` — node:test cases.
//   * `README.md` — usage + install.
//
// Heuristics:
//   - Backtick-quoted paths in `## Files` bullets become directories
//     (parent of the path) and empty placeholder files (the path itself).
//   - JSON-ish tokens in the bullet description (`type: module`,
//     `dependencies: { foo: ^1 }`) get parsed loosely and merged into
//     a starter package.json.
//   - tsconfig is a Node 22 ESM default with `allowJs+checkJs+noEmit`
//     when the spec lists `.js` files (matches v7.1.6 benchmark project),
//     or compiled NodeNext when it lists `.ts`.
//
// What this DELIBERATELY does NOT do:
//   - Run `npm install`. The user can decide which package manager.
//   - Pick a test runner if the spec doesn't say. Echoes `npm test`.
//   - Generate the CLAUDE.md (that's v7.1.7's job).
//
// Exit codes:
//   0 — scaffolded (or all targets already existed; idempotent)
//   1 — spec file missing or not readable
//   2 — spec missing a `## Files` section

import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';

const PASS = '\x1b[32m✓\x1b[0m';
const SKIP = '\x1b[2m·\x1b[0m';
const BOLD = (t: string) => `\x1b[1m${t}\x1b[0m`;
const DIM  = (t: string) => `\x1b[2m${t}\x1b[0m`;

export interface ScaffoldOptions {
  cwd?: string;
  specPath: string;
  /** When true, log what would happen but don't write anything. */
  dryRun?: boolean;
}

export interface ScaffoldResult {
  filesCreated: string[];
  dirsCreated: string[];
  filesSkippedExisting: string[];
  packageJsonAction: 'created' | 'merged' | 'skipped-exists';
  tsconfigAction: 'created' | 'skipped-exists' | 'skipped-no-ts';
}

interface ParsedFiles {
  /** Raw paths extracted from the `## Files` section bullets. */
  paths: string[];
  /** Loosely-parsed package.json hints found anywhere in the section. */
  packageHints: {
    bin?: Record<string, string>;
    type?: 'module' | 'commonjs';
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
}

/**
 * Parse the `## Files` (or `## files`) section of a spec markdown file.
 * Tolerant: missing section returns `null`; malformed bullets are skipped
 * silently. Returns extracted file paths + best-effort package-hint blob.
 */
export function parseSpecFiles(markdown: string): ParsedFiles | null {
  const filesSectionRe = /^##\s+files\s*$/im;
  const m = filesSectionRe.exec(markdown);
  if (!m) return null;
  const startIdx = m.index + m[0].length;
  // Section ends at next heading or EOF.
  const tail = markdown.slice(startIdx);
  const nextHeadingMatch = /^#{1,6}\s+\S/m.exec(tail);
  const sectionBody = nextHeadingMatch
    ? tail.slice(0, nextHeadingMatch.index)
    : tail;

  const paths: string[] = [];
  // Bullet line: `* \`path\` — desc` or `- \`path\` — desc`.
  const bulletRe = /^[*-]\s+`([^`]+)`/gm;
  let bm: RegExpExecArray | null;
  while ((bm = bulletRe.exec(sectionBody)) !== null) {
    const captured = bm[1];
    if (!captured) continue;
    const raw = captured.trim();
    // Skip prose-y entries by requiring path-shape: contains `/` or
    // ends in known ext, OR is a known root-level file.
    if (
      /[/.](?:js|ts|tsx|jsx|md|json|yaml|yml|sh|py|rs|go|rb|sql)$/i.test(raw) ||
      raw === 'package.json' ||
      raw === 'tsconfig.json' ||
      raw === 'README.md' ||
      raw === '.gitignore'
    ) {
      paths.push(raw);
    }
  }

  // Loose package.json hint extraction. Look for inline tokens.
  const packageHints: ParsedFiles['packageHints'] = {};
  if (/`?type\s*:\s*['"`]?module['"`]?/.test(sectionBody)) packageHints.type = 'module';
  // bin: { foo: bin/foo.js }
  const binMatch = /bin\s*:\s*\{\s*([^}]+)\s*\}/.exec(sectionBody);
  const binBody = binMatch?.[1];
  if (binBody) {
    const entries: Record<string, string> = {};
    for (const part of binBody.split(',')) {
      const [name, target] = part.split(':').map((s) => s.trim().replace(/['"`]/g, ''));
      if (name && target) entries[name] = target;
    }
    if (Object.keys(entries).length > 0) packageHints.bin = entries;
  }
  // dependencies: { foo: ^1 }
  const depMatch = /dependencies\s*:\s*\{\s*([^}]+)\s*\}/i.exec(sectionBody);
  const depBody = depMatch?.[1];
  if (depBody) {
    const entries: Record<string, string> = {};
    for (const part of depBody.split(',')) {
      const [name, version] = part.split(':').map((s) => s.trim().replace(/['"`]/g, ''));
      if (name && version) entries[name] = version;
    }
    if (Object.keys(entries).length > 0) packageHints.dependencies = entries;
  }
  // scripts: { test: "..." }  (handles quoted values via a 2nd pass)
  const scriptsMatch = /scripts\s*:\s*\{\s*([^}]+)\s*\}/i.exec(sectionBody);
  const scriptsBody = scriptsMatch?.[1];
  if (scriptsBody) {
    const entries: Record<string, string> = {};
    // Use looser splitter — colon inside quoted values is fine.
    const partRe = /([a-z_-]+)\s*:\s*["']([^"']+)["']/gi;
    let pm: RegExpExecArray | null;
    while ((pm = partRe.exec(scriptsBody)) !== null) {
      const [, key, value] = pm;
      if (key && value) entries[key] = value;
    }
    if (Object.keys(entries).length > 0) packageHints.scripts = entries;
  }

  return { paths, packageHints };
}

/**
 * Build a minimal starter package.json. Caller passes in any explicit
 * hints (parsed from spec); we layer Node 22 ESM defaults on top.
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

export async function runScaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const cwd = opts.cwd ?? process.cwd();
  const specAbs = path.isAbsolute(opts.specPath) ? opts.specPath : path.join(cwd, opts.specPath);

  if (!fs.existsSync(specAbs)) {
    process.stderr.write(`[scaffold] spec file not found: ${specAbs}\n`);
    process.exit(1);
  }
  const md = await fsAsync.readFile(specAbs, 'utf8');
  const parsed = parseSpecFiles(md);
  if (!parsed) {
    process.stderr.write(`[scaffold] spec missing a "## Files" section: ${specAbs}\n`);
    process.exit(2);
  }

  console.log(`\n${BOLD('[scaffold]')} ${DIM(specAbs)}\n`);

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
    if (!opts.dryRun) await fsAsync.mkdir(abs, { recursive: true });
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
    if (!opts.dryRun) {
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
      if (!opts.dryRun) {
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
      if (!opts.dryRun) {
        await fsAsync.writeFile(tsAbs, JSON.stringify(config, null, 2) + '\n', 'utf8');
      }
      const flavor = config === STARTER_TSCONFIG_TS ? 'compiled TS to dist/' : 'JS w/ JSDoc + checkJs';
      console.log(`  ${PASS}  write   ${DIM(`tsconfig.json (${flavor})`)}`);
    }
  }

  console.log(
    `\n${BOLD('Done.')} ${DIM(`${dirsCreated.length} dirs, ${filesCreated.length} files created, ${filesSkippedExisting.length} skipped.`)}\n`,
  );
  if (opts.dryRun) console.log(DIM(`(--dry-run: no files were written)\n`));

  return { filesCreated, dirsCreated, filesSkippedExisting, packageJsonAction, tsconfigAction };
}
