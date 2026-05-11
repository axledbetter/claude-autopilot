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
    //
    // Forms we must flag (value imports, all bypass `import type`):
    //   import '@supabase/supabase-js';                       // side-effect (NO importClause)
    //   import x from '@supabase/supabase-js';                // default value import
    //   import * as ns from '@supabase/supabase-js';          // namespace value import
    //   import { x } from '@supabase/supabase-js';            // named value import
    //   import x, { y } from '@supabase/supabase-js';         // default + named
    //   import x, { type Y } from '@supabase/supabase-js';    // default value, named type-only
    //
    // Forms we must NOT flag (type-only, erased at compile time):
    //   import type { ... } from '@supabase/supabase-js';     // whole clause type-only
    //   import { type X, type Y } from '@supabase/supabase-js'; // ALL named type-only AND no default/namespace
    if (ts.isImportDeclaration(node)) {
      const spec = moduleSpecifierText(node.moduleSpecifier);
      if (spec === PKG && !allowed) {
        const importClause = node.importClause;

        if (!importClause) {
          // Side-effect-only import: `import '@supabase/supabase-js';`
          // No importClause at all — clearly a value-side effect.
          record(node, 'side-effect import of @supabase/supabase-js outside dashboard allowlist');
        } else if (importClause.isTypeOnly) {
          // `import type { ... } from '...'` — fully erased.
        } else {
          // Default import (`importClause.name`) is a value import whenever
          // the clause isn't whole-type-only. Older audit gated this on
          // namedBindings being truthy, which silently missed
          // `import x from '...'` (no named bindings).
          const hasDefaultValueImport = !!importClause.name;
          const namedBindings = importClause.namedBindings;
          const hasNamespaceValueImport =
            !!namedBindings && ts.isNamespaceImport(namedBindings);
          const hasNamedValueImport =
            !!namedBindings &&
            ts.isNamedImports(namedBindings) &&
            namedBindings.elements.some((el) => !el.isTypeOnly);

          if (hasDefaultValueImport || hasNamespaceValueImport || hasNamedValueImport) {
            record(node, 'static value-import of @supabase/supabase-js outside dashboard allowlist');
          }
        }
      }
    }

    // export ... from '@supabase/supabase-js'
    //   export { x } from '@supabase/supabase-js';     // re-export — value
    //   export * from '@supabase/supabase-js';         // namespace re-export — value
    //   export type { X } from '@supabase/supabase-js'; // type-only — erased
    //   export { type X } from '@supabase/supabase-js'; // all-type-only named re-export — erased
    if (ts.isExportDeclaration(node)) {
      const spec = moduleSpecifierText(node.moduleSpecifier);
      if (spec === PKG && !node.isTypeOnly && !allowed) {
        // If the export clause is `export { type X }` and EVERY specifier
        // is type-only, treat as erased. `export *` has no clause and is
        // always a value re-export.
        const clause = node.exportClause;
        let isAllTypeOnly = false;
        if (clause && ts.isNamedExports(clause)) {
          isAllTypeOnly =
            clause.elements.length > 0 &&
            clause.elements.every((el) => el.isTypeOnly);
        }
        if (!isAllTypeOnly) {
          record(node, 're-export from @supabase/supabase-js outside dashboard allowlist');
        }
      }
    }

    // TypeScript `import x = require('@supabase/supabase-js')` —
    // CommonJS-flavored import that creates a value binding.
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && !allowed) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref)) {
        const expr = ref.expression;
        if (
          expr &&
          (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) &&
          expr.text === PKG
        ) {
          record(node, "import = require('@supabase/supabase-js') outside dashboard allowlist");
        }
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

/**
 * Test seam: audit a single source string. The path determines whether the
 * dashboard allowlist applies (callers can pass `src/cli/dashboard/foo.ts`
 * to verify allowlist behavior, or `src/whatever.ts` to verify failure).
 * Returns the list of violations.
 */
export function auditSourceForTest(filePath: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const allowed = isAllowed(filePath);
  const record = (node: ts.Node, reason: string): void => {
    const { line, col } = lineColFromOffset(source, node.getStart(sf));
    const snippetEnd = source.indexOf('\n', node.getStart(sf));
    const snippet = source.slice(node.getStart(sf), snippetEnd === -1 ? node.getEnd() : snippetEnd).trim();
    violations.push({ file: filePath, line, col, reason, snippet });
  };
  // Inline-equivalent of inspectFile's visitor — we duplicate the small
  // amount of traversal logic here so the public test seam doesn't need
  // to reach into module-private helpers.
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = (() => {
        const s = node.moduleSpecifier;
        return ts.isStringLiteral(s) || ts.isNoSubstitutionTemplateLiteral(s) ? s.text : null;
      })();
      if (spec === PKG && !allowed) {
        const importClause = node.importClause;
        if (!importClause) {
          record(node, 'side-effect import of @supabase/supabase-js outside dashboard allowlist');
        } else if (!importClause.isTypeOnly) {
          const hasDefault = !!importClause.name;
          const nb = importClause.namedBindings;
          const hasNs = !!nb && ts.isNamespaceImport(nb);
          const hasNamedValue = !!nb && ts.isNamedImports(nb) && nb.elements.some((el) => !el.isTypeOnly);
          if (hasDefault || hasNs || hasNamedValue) {
            record(node, 'static value-import of @supabase/supabase-js outside dashboard allowlist');
          }
        }
      }
    }
    if (ts.isExportDeclaration(node)) {
      const ms = node.moduleSpecifier;
      const spec = ms && (ts.isStringLiteral(ms) || ts.isNoSubstitutionTemplateLiteral(ms)) ? ms.text : null;
      if (spec === PKG && !node.isTypeOnly && !allowed) {
        const clause = node.exportClause;
        let isAllTypeOnly = false;
        if (clause && ts.isNamedExports(clause)) {
          isAllTypeOnly = clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
        }
        if (!isAllTypeOnly) {
          record(node, 're-export from @supabase/supabase-js outside dashboard allowlist');
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && !allowed) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref)) {
        const expr = ref.expression;
        if (expr && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) && expr.text === PKG) {
          record(node, "import = require('@supabase/supabase-js') outside dashboard allowlist");
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require' && node.arguments.length === 1;
      const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1;
      if (isRequire || isImportCall) {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && arg.text === PKG && !allowed) {
          record(
            node,
            isRequire
              ? "require('@supabase/supabase-js') outside dashboard allowlist"
              : "dynamic import('@supabase/supabase-js') outside dashboard allowlist",
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

// Only auto-run as a script when invoked directly (e.g. `tsx
// scripts/audit-supabase-imports.ts`). Importing it from a test must NOT
// trigger process.exit().
const invokedAsScript = (() => {
  try {
    return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  process.exit(main());
}
