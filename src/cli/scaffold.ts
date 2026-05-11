// v7.4.0 — `claude-autopilot scaffold --from-spec <path>` (per-stack).
//
// History:
//   v7.2.0 — initial verb, Node ESM only.
//   v7.4.0 — split per-stack scaffolders into ./scaffold/{node,python}.ts.
//            This file remains the public entry point + stack detector +
//            dispatcher; src/index.ts continues to re-export `runScaffold`,
//            `parseSpecFiles`, `buildStarterPackageJson`, plus the
//            `ScaffoldOptions` / `ScaffoldResult` types from here so library
//            consumers don't break.
//
// Stack detection lives in `detectStack()`. Per the spec ("Stack detection"
// section), precedence is:
//   1. explicit --stack flag (validated; unknown -> exit 3)
//   2. FastAPI (path + 'fastapi' mention) — checked BEFORE generic Python so
//      a FastAPI spec listing pyproject.toml isn't mis-classified
//   3. Python (pyproject.toml or requirements.txt)
//   4. Node (package.json)
//   5. Detected-but-unsupported (go.mod / Cargo.toml / Gemfile) -> exit 3
//   6. Fallback: Node ESM (preserves v7.2.0 default for ambiguous specs)
//
// Polyglot guard: package.json AND pyproject.toml together without --stack
// -> exit 3 with "polyglot spec — pass --stack to disambiguate".
//
// Exit codes:
//   0 — scaffolded
//   1 — spec file missing
//   2 — spec missing `## Files` section
//   3 (NEW v7.4.0) — `--stack` value not recognized, detected-but-unsupported
//                    stack (Go/Rust/Ruby), or polyglot spec without --stack

import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';

import { scaffoldNode, buildStarterPackageJson } from './scaffold/node.ts';
import { scaffoldPython } from './scaffold/python.ts';
import type {
  ParsedFiles,
  ScaffoldOptions,
  ScaffoldResult,
  Stack,
  UnsupportedStack,
} from './scaffold/types.ts';

const BOLD = (t: string) => `\x1b[1m${t}\x1b[0m`;
const DIM  = (t: string) => `\x1b[2m${t}\x1b[0m`;

// Re-export types + the legacy buildStarterPackageJson so `src/index.ts` and
// the existing tests/scaffold.test.ts (which imports from this module) keep
// compiling without changes.
export { buildStarterPackageJson };
export type { ScaffoldOptions, ScaffoldResult, ParsedFiles, Stack };

/** Valid `--stack` argument values. v7.5+ adds 'go', 'rust', 'ruby'. */
export const SUPPORTED_STACKS: readonly Stack[] = ['node', 'python', 'fastapi'];

/** Stacks we DETECT-but-don't-support yet. Mapped to spec exit-3 messages. */
export const UNSUPPORTED_STACK_FILES: Record<UnsupportedStack, string> = {
  go: 'go.mod',
  rust: 'Cargo.toml',
  ruby: 'Gemfile',
};

/**
 * Parse the `## Files` (or `## files`) section of a spec markdown file.
 * Tolerant: missing section returns `null`; malformed bullets are skipped
 * silently. Returns extracted file paths + best-effort package-hint blob.
 *
 * v7.4.0 also extracts:
 *   - `stackHint` — first prose mention of `fastapi` / `python` / `node`
 *     (case-insensitive). Used as a tie-breaker when path heuristics are
 *     ambiguous between Python and FastAPI.
 *   - `pythonDeps` — narrow extraction per spec ("Dependency hint
 *     extraction"): explicit `dependencies: [...]` block, backticked
 *     package names with extras, and the phrase `depends on <name>`.
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
    // ends in known ext, OR is a known root-level file. v7.4.0 adds
    // `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `Gemfile`,
    // `go.mod` to the root-file allowlist so the stack detector can see
    // them.
    if (
      /[/.](?:js|ts|tsx|jsx|md|json|yaml|yml|sh|py|rs|go|rb|sql|toml)$/i.test(raw) ||
      raw === 'package.json' ||
      raw === 'tsconfig.json' ||
      raw === 'README.md' ||
      raw === '.gitignore' ||
      raw === 'pyproject.toml' ||
      raw === 'requirements.txt' ||
      raw === 'Cargo.toml' ||
      raw === 'Gemfile' ||
      raw === 'go.mod'
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
  // dependencies: { foo: ^1 }   — Node-shape (object form).
  // Skip if it looks like an array (Python-shape `dependencies: [...]`)
  // — that's handled below as a Python dep block.
  const depObjMatch = /dependencies\s*:\s*\{\s*([^}]+)\s*\}/i.exec(sectionBody);
  const depObjBody = depObjMatch?.[1];
  if (depObjBody) {
    const entries: Record<string, string> = {};
    for (const part of depObjBody.split(',')) {
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

  // v7.4.0 — Python dep extraction (narrow contract, codex W6).
  // Pattern 1: explicit `dependencies: [foo, bar, baz]` array form.
  // We deliberately accept the Python-style array AFTER the Node-style
  // object check above so a Node spec with `dependencies: { foo: ^1 }`
  // still flows into packageHints.dependencies.
  const pythonDeps: string[] = [];
  const depArrayMatch = /dependencies\s*:\s*\[\s*([^\]]+)\s*\]/i.exec(sectionBody);
  const depArrayBody = depArrayMatch?.[1];
  if (depArrayBody) {
    for (const raw of depArrayBody.split(',')) {
      const cleaned = raw.trim().replace(/^[`'"]/, '').replace(/[`'"]$/, '');
      if (cleaned) pythonDeps.push(cleaned);
    }
  }
  // Pattern 2: backticked package names with extras. We look for
  // backticks containing `name[extra]` (with or without a version
  // suffix). This is intentionally narrow — `foo` alone in backticks
  // could be anything (filename, prose), so we require the `[extra]`
  // shape to fire this pattern.
  const extrasRe = /`([A-Za-z][A-Za-z0-9._-]*\[[^\]`]+\][^`]*)`/g;
  let em: RegExpExecArray | null;
  while ((em = extrasRe.exec(sectionBody)) !== null) {
    const value = em[1]?.trim();
    if (value) pythonDeps.push(value);
  }
  // Pattern 3: phrase `depends on <name>`. We capture the next
  // identifier-shaped token (PEP 508 names: letters / digits / `._-`).
  const dependsOnRe = /depends\s+on\s+`?([A-Za-z][A-Za-z0-9._-]*(?:\[[^\]]+\])?(?:[<>=!~][^\s`]+)?)`?/gi;
  let dm: RegExpExecArray | null;
  while ((dm = dependsOnRe.exec(sectionBody)) !== null) {
    const name = dm[1]?.trim();
    if (name) pythonDeps.push(name);
  }
  if (pythonDeps.length > 0) packageHints.pythonDeps = pythonDeps;

  // v7.4.0 — stack hint extraction. First-match wins, FastAPI checked
  // before generic Python (codex C1) so prose like "FastAPI app on
  // Python 3.12" classifies as fastapi, not python.
  if (/\bfastapi\b/i.test(sectionBody)) {
    packageHints.stackHint = 'fastapi';
  } else if (/\bpython\b/i.test(sectionBody)) {
    packageHints.stackHint = 'python';
  } else if (/\bnode(?:\.js)?\s+\d+\b/i.test(sectionBody)) {
    packageHints.stackHint = 'node';
  }

  return { paths, packageHints };
}

/**
 * Result of stack detection. `kind` is one of:
 *   - 'resolved'    — `stack` is set; proceed.
 *   - 'unsupported' — detected an unsupported stack file (Go/Rust/Ruby).
 *                     Caller exits 3 with `message`.
 *   - 'polyglot'    — both Node + Python markers present without --stack.
 *                     Caller exits 3 with `message`.
 */
export type StackDetection =
  | { kind: 'resolved'; stack: Stack }
  | { kind: 'unsupported'; stack: UnsupportedStack; message: string }
  | { kind: 'polyglot'; message: string };

/**
 * Apply the precedence ladder documented at the top of this file. Pure
 * function — no I/O — so it's directly unit-testable.
 */
export function detectStack(parsed: ParsedFiles, explicit?: Stack): StackDetection {
  // Step 1: explicit override always wins.
  if (explicit) return { kind: 'resolved', stack: explicit };

  const paths = parsed.paths;
  const has = (name: string) => paths.includes(name);
  const hasMainPy = paths.some(p =>
    p === 'main.py' ||
    p === 'app/main.py' ||
    /^src\/[^/]+\/main\.py$/.test(p),
  );
  const hasFastapiMention = parsed.packageHints.stackHint === 'fastapi';

  const hasPythonMarker = has('pyproject.toml') || has('requirements.txt');
  const hasNodeMarker = has('package.json');

  // Polyglot guard (codex W3) — Node + Python without --stack.
  if (hasNodeMarker && hasPythonMarker) {
    return {
      kind: 'polyglot',
      message: 'polyglot spec — pass --stack to disambiguate',
    };
  }

  // Step 2: FastAPI (BEFORE generic Python — codex C1).
  if (hasMainPy && hasFastapiMention) {
    return { kind: 'resolved', stack: 'fastapi' };
  }
  // Edge: spec lists pyproject.toml AND mentions FastAPI in prose but
  // doesn't list main.py — still classify as FastAPI; we generate
  // main.py ourselves anyway.
  if (hasPythonMarker && hasFastapiMention) {
    return { kind: 'resolved', stack: 'fastapi' };
  }

  // Step 3: Python.
  if (hasPythonMarker) return { kind: 'resolved', stack: 'python' };

  // Step 4: Node.
  if (hasNodeMarker) return { kind: 'resolved', stack: 'node' };

  // Step 5: detected-but-unsupported (codex W2).
  for (const [stack, file] of Object.entries(UNSUPPORTED_STACK_FILES) as [UnsupportedStack, string][]) {
    if (has(file)) {
      return {
        kind: 'unsupported',
        stack,
        message: `${stack} detected but not supported until v7.5`,
      };
    }
  }

  // Step 6: fallback — Node ESM (preserves v7.2.0 default for ambiguous
  // specs that listed only paths with no root-marker file).
  return { kind: 'resolved', stack: 'node' };
}

/**
 * Print the `--list-stacks` output (codex NOTE #2). Three sections:
 * Supported, Auto-detected, Recognized-but-unsupported.
 */
export function printStackList(): void {
  console.log('');
  console.log(BOLD('Supported (--stack accepts these):'));
  console.log('  node     Node 22 ESM (package.json + tsconfig.json)');
  console.log('  python   Python 3.11+ (pyproject.toml + hatchling + pytest)');
  console.log('  fastapi  Python + FastAPI (auto-includes fastapi + uvicorn[standard])');
  console.log('');
  console.log(BOLD('Auto-detected from `## Files`:'));
  console.log('  node     when `package.json` is listed');
  console.log('  python   when `pyproject.toml` or `requirements.txt` is listed');
  console.log('  fastapi  when `main.py` is listed AND a bullet mentions `fastapi`');
  console.log('');
  console.log(BOLD('Recognized-but-unsupported (exit 3):'));
  console.log('  go       v7.5  (would detect via go.mod)');
  console.log('  rust     v7.5  (would detect via Cargo.toml)');
  console.log('  ruby     v7.5+ (would detect via Gemfile)');
  console.log('');
}

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

  // Validate explicit --stack value. The CLI dispatch in src/cli/index.ts
  // also validates, but doing it here too means library consumers calling
  // `runScaffold({ stack: 'python' })` get the same guard.
  if (opts.stack && !SUPPORTED_STACKS.includes(opts.stack)) {
    process.stderr.write(
      `[scaffold] --stack "${opts.stack}" not recognized — supported: ${SUPPORTED_STACKS.join(', ')}\n`,
    );
    process.exit(3);
  }

  const detection = detectStack(parsed, opts.stack);
  if (detection.kind === 'unsupported') {
    process.stderr.write(`[scaffold] ${detection.message}\n`);
    process.exit(3);
  }
  if (detection.kind === 'polyglot') {
    process.stderr.write(`[scaffold] ${detection.message}\n`);
    process.exit(3);
  }
  const stack = detection.stack;

  console.log(`\n${BOLD('[scaffold]')} ${DIM(specAbs)} ${DIM(`(stack: ${stack})`)}\n`);

  // codex W5 — when --stack <python|fastapi> is explicit and the spec
  // ALSO lists Node files, warn + filter them out so the Python
  // scaffolder doesn't try to touch them.
  let ignoredOtherStackFiles: string[] | undefined;
  let parsedForStack = parsed;
  if (opts.stack && (stack === 'python' || stack === 'fastapi')) {
    const NODE_FILES = new Set(['package.json', 'tsconfig.json']);
    const ignored = parsed.paths.filter(p => NODE_FILES.has(p));
    if (ignored.length > 0) {
      ignoredOtherStackFiles = ignored;
      console.log(
        `  ${DIM(`! ignoring Node files (--stack ${stack}): ${ignored.join(', ')}`)}`,
      );
      parsedForStack = {
        ...parsed,
        paths: parsed.paths.filter(p => !NODE_FILES.has(p)),
      };
    }
  } else if (opts.stack === 'node') {
    // Symmetric: when --stack node is forced and the spec also lists
    // Python markers, drop them so we don't touch them as placeholders.
    const PYTHON_FILES = new Set(['pyproject.toml', 'requirements.txt']);
    const ignored = parsed.paths.filter(p => PYTHON_FILES.has(p));
    if (ignored.length > 0) {
      ignoredOtherStackFiles = ignored;
      console.log(
        `  ${DIM(`! ignoring Python files (--stack node): ${ignored.join(', ')}`)}`,
      );
      parsedForStack = {
        ...parsed,
        paths: parsed.paths.filter(p => !PYTHON_FILES.has(p)),
      };
    }
  }

  const ctx = { cwd, parsed: parsedForStack, dryRun: !!opts.dryRun };
  let result: ScaffoldResult;
  if (stack === 'python') {
    result = await scaffoldPython(ctx, { isFastapi: false });
  } else if (stack === 'fastapi') {
    result = await scaffoldPython(ctx, { isFastapi: true });
  } else {
    result = await scaffoldNode(ctx);
  }

  result.stack = stack;
  if (ignoredOtherStackFiles) result.ignoredOtherStackFiles = ignoredOtherStackFiles;

  console.log(
    `\n${BOLD('Done.')} ${DIM(`${result.dirsCreated.length} dirs, ${result.filesCreated.length} files created, ${result.filesSkippedExisting.length} skipped.`)}\n`,
  );
  if (opts.dryRun) console.log(DIM(`(--dry-run: no files were written)\n`));

  return result;
}
