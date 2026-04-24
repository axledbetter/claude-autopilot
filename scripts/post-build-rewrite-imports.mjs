#!/usr/bin/env node
/**
 * Post-tsc-build rewriter: strips `.ts` extensions from relative import specifiers
 * in emitted JavaScript, replacing them with `.js` so Node ESM can resolve them.
 *
 * Background: the source uses `import x from './foo.ts'` (works under tsx, which
 * accepts .ts specifiers). TSC with `moduleResolution: Bundler` emits these as-is
 * to .js files, but Node's runtime ESM resolver won't load a `.ts` file at runtime.
 * This walk rewrites all relative `.ts` → `.js` in the emitted output.
 *
 * Non-relative imports (`from 'foo'`, `from '@scope/foo'`) are left alone.
 * Type-only imports are also rewritten (they show up in compiled JS when erased,
 * but only when the compiler chooses to preserve them — harmless to rewrite).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// Match:  from './foo.ts'  |  from '../bar/baz.ts'  |  import('./foo.ts')
// Leave alone: from 'pkg'  |  from '@scope/pkg'  |  from 'node:path'
const SPECIFIER = /(from\s+['"]|import\s*\(\s*['"])(\.\.?\/[^'"]+?)\.ts(['"])/g;

let filesTouched = 0;
let replacements = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
    } else if (entry.isFile() && (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.js.map'))) {
      rewrite(p);
    }
  }
}

function rewrite(file) {
  const original = fs.readFileSync(file, 'utf8');
  let count = 0;
  const updated = original.replace(SPECIFIER, (_, lead, spec, quote) => {
    count++;
    return `${lead}${spec}.js${quote}`;
  });
  if (count > 0) {
    fs.writeFileSync(file, updated);
    filesTouched++;
    replacements += count;
  }
}

if (!fs.existsSync(DIST)) {
  console.error(`[post-build] dist/ not found at ${DIST}. Run \`tsc -p tsconfig.build.json\` first.`);
  process.exit(1);
}

walk(DIST);
console.log(`[post-build] Rewrote ${replacements} .ts→.js import specifiers across ${filesTouched} files in ${DIST}`);
