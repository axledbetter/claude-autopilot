import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from '../core/config/loader.ts';
import { runDeployPhase, type DeployPhaseResult } from '../core/phases/deploy.ts';
import { postPrComment, DEPLOY_COMMENT_MARKER } from './pr-comment.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface DeployCommandOptions {
  cwd?: string;
  configPath?: string;
  /** PR number — if set, posts result as a comment on the PR via gh CLI. */
  prNumber?: string;
  /** Override deployCommand from CLI (skips config). */
  command?: string;
  /** Override healthCheckUrl from CLI. */
  healthUrl?: string;
  dryRun?: boolean;
}

function formatComment(result: DeployPhaseResult, command: string): string {
  const status = result.status === 'pass' ? '✅ Deploy succeeded' : result.status === 'fail' ? '❌ Deploy failed' : '⊘ Deploy skipped';
  const lines: string[] = [
    // Marker MUST be the first line so postPrComment's startswith() dedup
    // works — repeated `deploy --pr 42` invocations will update the same
    // comment instead of spamming new ones.
    DEPLOY_COMMENT_MARKER,
    `## ${status}`,
    '',
    `**Command:** \`${command}\`  `,
    `**Duration:** ${(result.durationMs / 1000).toFixed(1)}s  `,
  ];
  if (result.deployUrl) lines.push(`**URL:** ${result.deployUrl}  `);
  if (result.healthOk !== undefined) lines.push(`**Health check:** ${result.healthOk ? 'OK' : 'FAILED'}  `);
  if (result.output) {
    lines.push('', '<details><summary>Command output</summary>', '', '```', result.output.slice(-2000), '```', '</details>');
  }
  lines.push('', '<sub>Posted by `claude-autopilot deploy`.</sub>');
  return lines.join('\n');
}

export async function runDeploy(options: DeployCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  // Load config when present, regardless of whether --command was given. CLI
  // flags override individual config fields; --command shouldn't bypass the
  // entire config and silently drop the user's `healthCheckUrl`. (Bugbot MED
  // on PR #56 flagged this — `flyctl deploy --command "flyctl deploy --strategy=immediate"`
  // would lose the health check the user had set in their committed config.)
  let configDeployCommand: string | null | undefined;
  let configHealthCheckUrl: string | null | undefined;
  if (fs.existsSync(configPath)) {
    try {
      const config = await loadConfig(configPath);
      configDeployCommand = config.deployCommand;
      configHealthCheckUrl = config.healthCheckUrl;
    } catch (err) {
      console.error(fmt('red', `[deploy] Could not load config: ${err instanceof Error ? err.message : String(err)}`));
      return 1;
    }
  }

  const deployCommand = options.command ?? configDeployCommand ?? undefined;
  const healthCheckUrl = options.healthUrl ?? configHealthCheckUrl ?? undefined;

  if (!deployCommand) {
    if (!fs.existsSync(configPath)) {
      console.error(fmt('red', `[deploy] guardrail.config.yaml not found and no --command given.`));
      console.error(fmt('dim', `         Either pass \`--command "your deploy command"\` or run \`claude-autopilot setup\` first.`));
      return 1;
    }
    console.error(fmt('yellow', `[deploy] No \`deployCommand\` set in guardrail.config.yaml and no --command given. Skipping.`));
    console.error(fmt('dim', `         Add \`deployCommand: "vercel --prod"\` (or your equivalent) to enable.`));
    return 0;
  }

  console.log(fmt('bold', '[deploy]'), fmt('dim', deployCommand));
  if (healthCheckUrl) console.log(fmt('dim', `  health check: ${healthCheckUrl}`));

  if (options.dryRun) {
    console.log(fmt('yellow', '[deploy] --dry-run — would run above; nothing executed.'));
    return 0;
  }

  const result = await runDeployPhase({
    deployCommand,
    healthCheckUrl,
    cwd,
  });

  // Status line
  const statusFmt = result.status === 'pass' ? fmt('green', '✓ pass')
    : result.status === 'fail' ? fmt('red', '✗ fail')
    : fmt('dim', '⊘ skip');
  console.log(`  ${statusFmt} ${fmt('dim', `(${(result.durationMs / 1000).toFixed(1)}s)`)}`);
  if (result.deployUrl) console.log(fmt('cyan', `  → ${result.deployUrl}`));
  if (result.healthOk === false) console.log(fmt('red', `  ✗ health check failed`));
  if (result.healthOk === true) console.log(fmt('green', `  ✓ health check ok`));

  // Optional PR comment
  if (options.prNumber) {
    try {
      const { action } = await postPrComment(
        parseInt(options.prNumber, 10),
        formatComment(result, deployCommand),
        cwd,
        DEPLOY_COMMENT_MARKER,
      );
      console.log(fmt('dim', `  ${action} comment on PR #${options.prNumber}`));
    } catch {
      console.log(fmt('yellow', `  (could not post PR comment — is gh authenticated?)`));
    }
  }

  return result.status === 'fail' ? 1 : 0;
}
