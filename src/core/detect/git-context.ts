import { runSafe } from '../shell.ts';

export interface GitContext {
  branch: string | null;
  commitMessage: string | null;
  /** Short summary suitable for injecting into a review prompt */
  summary: string | null;
}

/**
 * Reads branch name and last commit message from git. Returns nulls gracefully
 * if git is unavailable or the repo has no commits.
 */
export function detectGitContext(cwd: string): GitContext {
  const branch = runSafe('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? null;
  const commitMessage = runSafe('git', ['-C', cwd, 'log', '-1', '--format=%s'])?.trim() ?? null;

  let summary: string | null = null;
  if (branch || commitMessage) {
    const parts: string[] = [];
    if (branch && branch !== 'HEAD') parts.push(`branch: ${branch}`);
    if (commitMessage) parts.push(`last commit: ${commitMessage}`);
    summary = parts.join(' | ');
  }

  return { branch, commitMessage, summary };
}
