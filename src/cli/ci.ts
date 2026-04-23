import { runCommand } from './run.ts';

export interface CiCommandOptions {
  cwd?: string;
  configPath?: string;
  base?: string;
  postComments?: boolean;
  sarifOutput?: string;
  diff?: boolean;
  inlineComments?: boolean;
  newOnly?: boolean;
  failOn?: 'critical' | 'warning' | 'note' | 'none';
}

/**
 * `guardrail ci` — opinionated single-command CI entrypoint.
 *
 * Defaults:
 *   base          GITHUB_BASE_REF → HEAD~1
 *   output        guardrail.sarif
 *   post-comments true
 *   fail-on       critical (or policy.failOn from config)
 *   new-only      false (or policy.newOnly from config)
 */
export async function runCi(options: CiCommandOptions = {}): Promise<number> {
  const base = options.base
    ?? process.env.GITHUB_BASE_REF
    ?? process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME  // GitLab
    ?? 'HEAD~1';

  const sarifOutput = options.sarifOutput ?? 'guardrail.sarif';

  return runCommand({
    cwd: options.cwd,
    configPath: options.configPath,
    base,
    postComments: options.postComments ?? true,
    format: 'sarif',
    outputPath: sarifOutput,
    diff: options.diff,
    inlineComments: options.inlineComments ?? true,
    newOnly: options.newOnly,
    failOn: options.failOn,
  });
}
