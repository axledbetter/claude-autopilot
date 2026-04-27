import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runCommand } from './run.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface PrCommandOptions {
  cwd?: string;
  configPath?: string;
  prNumber?: string;
  noPostComments?: boolean;
  noInlineComments?: boolean;
}

function ghJson<T>(args: string[], cwd: string): T | null {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout) as T; } catch { return null; }
}

function gitFetch(remote: string, ref: string, cwd: string): boolean {
  const r = spawnSync('git', ['fetch', remote, ref], { cwd, encoding: 'utf8', stdio: 'pipe' });
  return r.status === 0;
}

export async function runPr(options: PrCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  if (!fs.existsSync(configPath)) {
    console.error(fmt('red', `[pr] guardrail.config.yaml not found at ${configPath}`));
    return 1;
  }

  // Resolve PR number
  let prNumber = options.prNumber;
  if (!prNumber) {
    const detected = ghJson<{ number: number }>(['pr', 'view', '--json', 'number'], cwd);
    if (!detected) {
      console.error(fmt('red', '[pr] No PR number given and no open PR found for current branch.'));
      console.error(fmt('dim', '  Usage: guardrail pr <number>'));
      return 1;
    }
    prNumber = String(detected.number);
  }

  // Look up PR metadata
  interface PrMeta { number: number; baseRefName: string; headRefName: string; title: string }
  const pr = ghJson<PrMeta>(['pr', 'view', prNumber, '--json', 'number,baseRefName,headRefName,title'], cwd);
  if (!pr) {
    console.error(fmt('red', `[pr] Could not fetch PR #${prNumber} — is gh authenticated?`));
    return 1;
  }

  console.log(`\n${fmt('bold', `[pr]`)} #${pr.number} ${fmt('dim', pr.title)}`);
  console.log(fmt('dim', `  base: ${pr.baseRefName}  head: ${pr.headRefName}`));

  // Fetch base ref so diff works locally
  const fetched = gitFetch('origin', pr.baseRefName, cwd);
  if (!fetched) {
    console.log(fmt('yellow', `  [pr] Warning: could not fetch origin/${pr.baseRefName} — diff may be stale`));
  }

  return runCommand({
    cwd,
    configPath,
    base: `origin/${pr.baseRefName}`,
    postComments: !options.noPostComments,
    inlineComments: !options.noInlineComments,
  });
}
