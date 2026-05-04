import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Resolve the default base ref for git diffs in a CI-aware way.
 *
 * Priority: `GITHUB_BASE_REF` (GitHub Actions PR builds), then
 * `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` (GitLab MR builds), then `HEAD~1`
 * for local / single-commit contexts. Branch-name env vars are prefixed
 * with `origin/` so `git show <ref>:<file>` resolves to the
 * remote-tracking-branch tip (the actual merge base).
 *
 * Caught + extended by Cursor Bugbot follow-up on PR #44 (MEDIUM): a static
 * default of `HEAD~1` is wrong for multi-commit PRs — it points at the
 * previous commit on the branch, not the merge base.
 */
function resolveDefaultBase(): string {
  const ghBase = process.env.GITHUB_BASE_REF;
  if (ghBase && ghBase.length > 0) return `origin/${ghBase}`;
  const glBase = process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
  if (glBase && glBase.length > 0) return `origin/${glBase}`;
  return 'HEAD~1';
}

/**
 * Read the previous version of a file from git, comparing against `base`.
 * Returns null if the file has no git history at that ref (untracked,
 * brand-new, not in a repo, or the ref doesn't resolve) — callers should
 * fall back to whole-file extraction in that case.
 *
 * When `base` is omitted, the default is CI-aware (see `resolveDefaultBase`):
 * - GitHub Actions PR build → `origin/<GITHUB_BASE_REF>`
 * - GitLab MR build → `origin/<CI_MERGE_REQUEST_TARGET_BRANCH_NAME>`
 * - everything else → `HEAD~1`
 *
 * Reading from `HEAD` directly is wrong in CI (any post-commit context):
 * `HEAD` IS the current commit, so the diff against the working-tree file
 * is always empty and no schema entities are emitted. Caught by Cursor
 * Bugbot on PR #44 (HIGH); the multi-commit-PR variant of the same bug
 * caught as a MEDIUM follow-up on the rebased commit.
 */
export function getPreviousFileContent(
  filePath: string,
  cwd: string = process.cwd(),
  base: string = resolveDefaultBase(),
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
