/**
 * Resolves the canonical package root directory from the perspective of any
 * source file in the package. Robust under both source (`src/cli/foo.ts` →
 * `<root>`) and compiled (`dist/src/cli/foo.js` → `<root>`) layouts.
 *
 * Background: every site that hardcoded `path.resolve(dirname(fileURLToPath(...)), '..', '..')`
 * worked when called from the source layout but resolved one level shallow under
 * the compiled output (landing in `dist/` instead of the package root). The
 * real-world soak against `npx @delegance/claude-autopilot@alpha init` surfaced
 * this — `init` couldn't find `presets/<name>/guardrail.config.yaml` because it
 * was looking at `dist/presets/...` (which doesn't exist; presets ship at the
 * package root).
 *
 * This helper walks up from the caller's `import.meta.url` looking for the
 * `@delegance/claude-autopilot` package.json. Both source and compiled callers
 * land in the same place.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@delegance/claude-autopilot';

/**
 * Walks up from the caller's location looking for the package.json that
 * declares `name === '@delegance/claude-autopilot'`. Returns the directory
 * containing that package.json, or null if not found within `maxDepth` levels.
 */
export function findPackageRoot(callerImportMetaUrl: string, maxDepth = 10): string | null {
  let dir = path.dirname(fileURLToPath(callerImportMetaUrl));
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string };
        if (pkg.name === PACKAGE_NAME) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Throws a clear error if the package root can't be located. Use at sites that
 * absolutely require the root (e.g. preset config lookup).
 */
export function requirePackageRoot(callerImportMetaUrl: string): string {
  const root = findPackageRoot(callerImportMetaUrl);
  if (!root) {
    throw new Error(
      `[claude-autopilot] Could not locate package root from ${fileURLToPath(callerImportMetaUrl)}. ` +
      `Reinstall: npm install -g @delegance/claude-autopilot@alpha`,
    );
  }
  return root;
}
