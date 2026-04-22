import { runSafe } from '../../core/shell.ts';

export type CommitState = 'pending' | 'success' | 'failure' | 'error';

export interface CommitStatusOptions {
  sha: string;
  state: CommitState;
  description?: string;
  context?: string;
  targetUrl?: string;
  cwd?: string;
}

function getCurrentSha(cwd: string): string | null {
  return runSafe('git', ['rev-parse', 'HEAD'], { cwd })?.trim() ?? null;
}

export function resolveCommitSha(cwd: string, envSha?: string): string | null {
  return envSha
    ?? process.env.GITHUB_SHA
    ?? getCurrentSha(cwd);
}

export function postCommitStatus(opts: CommitStatusOptions): boolean {
  const payload = JSON.stringify({
    state: opts.state,
    description: (opts.description ?? '').slice(0, 140),
    context: opts.context ?? 'guardrail',
    ...(opts.targetUrl ? { target_url: opts.targetUrl } : {}),
  });

  const result = runSafe('gh', [
    'api', `repos/{owner}/{repo}/statuses/${opts.sha}`,
    '--method', 'POST',
    '--input', '-',
  ], { cwd: opts.cwd, input: payload });

  return result !== null;
}
