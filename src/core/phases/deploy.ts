import { execSync } from 'node:child_process';

export interface DeployPhaseInput {
  deployCommand?: string | null;
  healthCheckUrl?: string | null;
  cwd?: string;
  /** Override timeout (ms). Default 600_000 (10 min) — most deploys finish well under. */
  timeoutMs?: number;
  /**
   * Override health-check polling budget (ms). Default 60_000.
   * Tests pass a small value (e.g. 100) to avoid waiting the full minute
   * for the failure path on every suite run.
   */
  healthCheckTimeoutMs?: number;
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
  // Per-request budget. Without this, fetch() can hang indefinitely at the OS
  // TCP layer when the endpoint accepts the connection but never responds —
  // common during a bad deploy. The outer loop's deadline check would never
  // fire because no iteration ever completes. Cap each request at 5s and let
  // the loop retry until the overall budget runs out.
  const PER_REQUEST_MS = 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(PER_REQUEST_MS) });
      if (res.ok) return true;
    } catch {
      // Network errors / aborts are expected during cold-start — keep polling
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
    // Most deploy CLIs write errors to stderr (npm, vercel, flyctl, kubectl).
    // The prior version captured only stdout, so the resulting `output` was
    // typically just the "Deploy command failed" prefix with no diagnostics.
    // Concat both streams so users see the actual failure reason.
    const errObj = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const stdout = errObj.stdout?.toString() ?? '';
    const stderr = errObj.stderr?.toString() ?? '';
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim() || errObj.message || 'no output';
    return {
      phase: 'deploy',
      status: 'fail',
      output: `Deploy command failed: ${input.deployCommand}\n${combined}`,
      durationMs: Date.now() - start,
    };
  }

  const deployUrl = extractDeployUrl(output);

  if (input.healthCheckUrl) {
    const healthOk = await pollHealthCheck(input.healthCheckUrl, input.healthCheckTimeoutMs ?? 60_000);
    if (!healthOk) {
      // Preserve the deploy CLI output; prepend the health-check failure as a
      // header. The prior version overwrote `output` with a one-line synthetic
      // string, which then surfaced as the "Command output" body in the PR
      // comment, hiding the real deploy logs (version info, warnings, deploy
      // URL) the user needs to debug.
      const failHeader = `Deploy succeeded but health check failed after 60s: ${input.healthCheckUrl}`;
      return {
        phase: 'deploy',
        status: 'fail',
        output: `${failHeader}\n\n--- deploy command output ---\n${output}`,
        deployUrl,
        healthOk: false,
        durationMs: Date.now() - start,
      };
    }
    return { phase: 'deploy', status: 'pass', output, deployUrl, healthOk: true, durationMs: Date.now() - start };
  }

  return { phase: 'deploy', status: 'pass', output, deployUrl, durationMs: Date.now() - start };
}
