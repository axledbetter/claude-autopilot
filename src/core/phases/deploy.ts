import { execSync } from 'node:child_process';

export interface DeployPhaseInput {
  deployCommand?: string | null;
  healthCheckUrl?: string | null;
  cwd?: string;
  /** Override timeout (ms). Default 600_000 (10 min) — most deploys finish well under. */
  timeoutMs?: number;
}

export interface DeployPhaseResult {
  phase: 'deploy';
  status: 'pass' | 'fail' | 'skip';
  output?: string;
  /** First https?:// URL extracted from deploy command stdout, if present. */
  deployUrl?: string;
  /** True if healthCheckUrl was set and returned 200. False if it failed or wasn't checked. */
  healthOk?: boolean;
  durationMs: number;
}

// Most deploy CLIs print at least one URL. Take the FIRST one — Vercel,
// Netlify, Fly, Render, Cloudflare Pages, Railway all print the deployment
// URL on its own line near the end. Strip trailing punctuation that often
// hangs off CLI output (".", ",", ")").
function extractDeployUrl(output: string): string | undefined {
  const match = output.match(/https?:\/\/[^\s<>"']+/);
  if (!match) return undefined;
  return match[0].replace(/[.,)\]]+$/, '');
}

async function pollHealthCheck(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      // Network errors are expected during cold-start — keep polling
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

export async function runDeployPhase(input: DeployPhaseInput): Promise<DeployPhaseResult> {
  const start = Date.now();

  if (!input.deployCommand) {
    return { phase: 'deploy', status: 'skip', durationMs: Date.now() - start };
  }

  let output: string;
  try {
    output = execSync(input.deployCommand, {
      encoding: 'utf8',
      cwd: input.cwd,
      timeout: input.timeoutMs ?? 600_000,
      shell: process.env.SHELL ?? '/bin/sh',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const errOutput = (err as { stdout?: string; stderr?: string }).stdout ?? '';
    return {
      phase: 'deploy',
      status: 'fail',
      output: `Deploy command failed: ${input.deployCommand}\n${errOutput}`,
      durationMs: Date.now() - start,
    };
  }

  const deployUrl = extractDeployUrl(output);

  if (input.healthCheckUrl) {
    const healthOk = await pollHealthCheck(input.healthCheckUrl, 60_000);
    if (!healthOk) {
      return {
        phase: 'deploy',
        status: 'fail',
        output: `Deploy succeeded but health check failed after 60s: ${input.healthCheckUrl}`,
        deployUrl,
        healthOk: false,
        durationMs: Date.now() - start,
      };
    }
    return { phase: 'deploy', status: 'pass', output, deployUrl, healthOk: true, durationMs: Date.now() - start };
  }

  return { phase: 'deploy', status: 'pass', output, deployUrl, durationMs: Date.now() - start };
}
