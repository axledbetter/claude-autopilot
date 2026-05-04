import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Read the previous version of a file from git, comparing against `base`.
 * Returns null if the file has no git history at that ref (untracked,
 * brand-new, not in a repo, or the ref doesn't resolve) — callers should
 * fall back to whole-file extraction in that case.
 *
 * `base` defaults to `'HEAD~1'` to match `resolveGitTouchedFiles`. Reading
 * from `HEAD` directly is wrong in CI (and any post-commit context): `HEAD`
 * IS the current commit, so the diff against the working-tree file is
 * always empty and no schema entities are ever emitted. Caught by Cursor
 * Bugbot on PR #44 (HIGH).
 */
export function getPreviousFileContent(
  filePath: string,
  cwd: string = process.cwd(),
  base: string = 'HEAD~1',
): string | null {
  const relPath = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
  const result = spawnSync('git', ['show', `${base}:${relPath}`], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}
