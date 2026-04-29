import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Read the previous version of a file from git HEAD. Returns null if the file
 * has no git history (untracked, brand-new, or not in a repo) — callers should
 * fall back to whole-file extraction in that case.
 */
export function getPreviousFileContent(filePath: string, cwd: string = process.cwd()): string | null {
  const relPath = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
  const result = spawnSync('git', ['show', `HEAD:${relPath}`], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}
