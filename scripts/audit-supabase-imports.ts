// scripts/audit-supabase-imports.ts
//
// AST-based audit (spec amendment A4) for value-level imports of
// `@supabase/supabase-js` in `src/**/*.ts`. Type-only imports are erased at
// compile-time and are allowed everywhere; value imports / dynamic
// `import()` / `require()` are only allowed inside the dashboard lazy-load
// allowlist (`src/cli/dashboard/**`).
//
// The grep-based audit originally proposed in the spec is unreliable because
// it can't distinguish `import type { ... }` from value imports — TypeScript
// compiler API lets us catch only the actual offenders without false
// positives.
//
// Exit codes:
//   0 — clean
//   1 — at least one violation found, lists them on stderr
//
// Wire into CI via `npm run audit:supabase` (declared in package.json).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import ts from 'typescript';

const PKG = '@supabase/supabase-js';

// Files matching any of these path patterns are permitted to value-import
// (or dynamically import) the package. Everything else must use
// `import type { ... }`.
const ALLOWLIST_PATH_PARTS = [
  // Lazy-load dashboard upload uses the loadSupabaseOrInstallHint helper.
  path.join('src', 'cli', 'dashboard') + path.sep,
];

interface Violation {
  file: string;
  line: number;
  col: number;
  reason: string;
  snippet: string;
}

function isAllowed(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  return ALLOWLIST_PATH_PARTS.some((p) => norm.includes(p.replace(/\\/g, '/')));
}

function findFiles(root: string, exts: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  }
  walk(root);
  return out;
}

function lineColFromOffset(text: string, pos: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

function inspectFile(file: string, violations: Violation[]): void {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

  const allowed = isAllowed(file);

  function record(node: ts.Node, reason: string): void {
    const { line, col } = lineColFromOffset(src, node.getStart(sf));
    const snippetEnd = src.indexOf('\n', node.getStart(sf));
    const snippet = src.slice(node.getStart(sf), snippetEnd === -1 ? node.getEnd() : snippetEnd).trim();
    violations.push({ file, line, col, reason, snippet });
  }

  function moduleSpecifierText(spec: ts.Expression | undefined): string | null {
    if (!spec) return null;
    if (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec)) return spec.text;
    return null;
  }

  function visit(node: ts.Node): void {
    // import ... from '@supabase/supabase-js'
    if (ts.isImportDeclaration(node)) {
      const spec = moduleSpecifierText(node.moduleSpecifier);
      if (spec === PKG) {
        // Type-only imports are erased: `import type { ... } from '...'`
        // or `import { type X } from '...'` (named, all type-only).
        const isWholeTypeOnly = node.importClause?.isTypeOnly === true;
        const namedBindings = node.importClause?.namedBindings;
        const hasValueNamedImport =
          namedBindings && ts.isNamedImports(namedBindings)
            ? namedBindings.elements.some((el) => !el.isTypeOnly)
            : namedBindings && ts.isNamespaceImport(namedBindings)
              ? !isWholeTypeOnly
              : !!node.importClause?.name && !isWholeTypeOnly;

        if (!isWholeTypeOnly && hasValueNamedImport && !allowed) {
          record(node, 'static value-import of @supabase/supabase-js outside dashboard allowlist');
        }
      }
    }

    // export ... from '@supabase/supabase-js'
    if (ts.isExportDeclaration(node)) {
      const spec = moduleSpecifierText(node.moduleSpecifier);
      if (spec === PKG && !node.isTypeOnly && !allowed) {
        record(node, 're-export from @supabase/supabase-js outside dashboard allowlist');
      }
    }

    // require('@supabase/supabase-js') or import('@supabase/supabase-js')
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire =
        ts.isIdentifier(callee) && callee.text === 'require' && node.arguments.length === 1;
      const isImportCall =
        callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1;
      if (isRequire || isImportCall) {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          if (arg.text === PKG && !allowed) {
            record(
              node,
              isRequire
                ? "require('@supabase/supabase-js') outside dashboard allowlist"
                : "dynamic import('@supabase/supabase-js') outside dashboard allowlist",
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function main(): number {
  // Anchor at the worktree root — script lives at scripts/, repo root is ..
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const srcRoot = path.join(repoRoot, 'src');

  if (!fs.existsSync(srcRoot)) {
    process.stderr.write(`[audit] no src/ at ${srcRoot}\n`);
    return 1;
  }

  const files = findFiles(srcRoot, ['.ts', '.tsx']);
  const violations: Violation[] = [];
  for (const f of files) inspectFile(f, violations);

  if (violations.length === 0) {
    process.stdout.write(`[audit] OK — scanned ${files.length} files, no static value-imports of ${PKG} outside dashboard allowlist\n`);
    return 0;
  }

  process.stderr.write(`[audit] FOUND ${violations.length} violation(s):\n`);
  for (const v of violations) {
    const rel = path.relative(repoRoot, v.file);
    process.stderr.write(`  ${rel}:${v.line}:${v.col}  ${v.reason}\n`);
    process.stderr.write(`    ${v.snippet}\n`);
  }
  process.stderr.write(
    `\nAllowed forms anywhere: \`import type { ... } from '${PKG}'\`\n` +
      `Allowed allowlist paths: ${ALLOWLIST_PATH_PARTS.map((p) => p.replace(/\\/g, '/')).join(', ')}\n` +
      `See docs/specs/v7.8.0-decouple-runtime-deps.md amendment A4.\n`,
  );
  return 1;
}

process.exit(main());
