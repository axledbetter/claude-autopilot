import { runCommand } from './run.ts';

export interface CiCommandOptions {
  cwd?: string;
  configPath?: string;
  base?: string;
  postComments?: boolean;
  sarifOutput?: string;
  diff?: boolean;
  inlineComments?: boolean;
}

/**
 * `autopilot ci` — opinionated single-command CI entrypoint.
 *
 * Equivalent to:
 *   autopilot run --base <ref> --post-comments --format sarif --output <path>
 *
 * Defaults:
 *   base       GITHUB_BASE_REF → HEAD~1
 *   output     autopilot.sarif
 *   post-comments  true (skip if no PR detected — run.ts handles gracefully)
 */
export async function runCi(options: CiCommandOptions = {}): Promise<number> {
  const base = options.base
    ?? process.env.GITHUB_BASE_REF
    ?? process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME  // GitLab
    ?? 'HEAD~1';

  const sarifOutput = options.sarifOutput ?? 'autopilot.sarif';

  return runCommand({
    cwd: options.cwd,
    configPath: options.configPath,
    base,
    postComments: options.postComments ?? true,
    format: 'sarif',
    outputPath: sarifOutput,
    diff: options.diff,
    inlineComments: options.inlineComments ?? true,
  });
}
