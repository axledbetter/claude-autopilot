// src/adapters/deploy/vercel.ts
//
// First-class Vercel deploy adapter. Phase 1 of the v5.4 spec.
//
// Implements `deploy()` (POST + poll until terminal) and `status()` (one-shot
// GET). Log streaming is Phase 2; rollback is Phase 3.
//
// All HTTP calls go through an injectable `fetchImpl` so unit tests never hit
// the real Vercel API.
//
// Spec: docs/specs/v5.4-vercel-adapter.md

import { GuardrailError } from '../../core/errors.ts';
import type {
  DeployAdapter,
  DeployInput,
  DeployResult,
  DeployStatusInput,
  DeployStatusResult,
} from './types.ts';

const VERCEL_API_BASE = 'https://api.vercel.com';

/** Vercel deployment states. The first three are terminal; the rest are interim. */
type VercelState =
  | 'READY'
  | 'ERROR'
  | 'CANCELED'
  | 'BUILDING'
  | 'INITIALIZING'
  | 'QUEUED'
  | 'DEPLOYING'
  | 'ANALYZING';

interface VercelDeployResponse {
  id: string;
  url?: string;
  state?: VercelState;
  readyState?: VercelState;
}

export interface VercelDeployAdapterOptions {
  /** Personal access token. Falls back to `process.env.VERCEL_TOKEN`. */
  token?: string;
  /** Vercel project ID or slug. Required. */
  project: string;
  /** Vercel team ID. Optional — required only for team accounts. */
  team?: string;
  /** Deploy target. Default: `production`. */
  target?: 'production' | 'preview';
  /** Polling interval (ms) when waiting for the build to reach a terminal state. Default: 2000. */
  pollIntervalMs?: number;
  /** Maximum total time to poll before returning `in-progress`. Default: 15 minutes. */
  maxPollMs?: number;
  /** Injected fetch implementation — defaults to `globalThis.fetch`. Tests pass a mock. */
  fetchImpl?: typeof fetch;
  /** Injected sleep implementation — tests pass a no-op so they don't actually wait. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Wall-clock source — tests pass a controllable counter. */
  nowImpl?: () => number;
}

/**
 * Vercel deploy adapter.
 *
 * Construct once per pipeline run. The adapter is stateless across calls — all
 * configuration (token, project, team) is captured at construction time.
 */
export class VercelDeployAdapter implements DeployAdapter {
  readonly name = 'vercel';

  private readonly token: string;
  private readonly project: string;
  private readonly team: string | undefined;
  private readonly target: 'production' | 'preview';
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: VercelDeployAdapterOptions) {
    const token = opts.token ?? process.env.VERCEL_TOKEN;
    if (!token) {
      throw new GuardrailError(
        'Vercel deploy adapter requires VERCEL_TOKEN. Create one at https://vercel.com/account/tokens',
        { code: 'auth', provider: 'vercel' },
      );
    }
    if (!opts.project) {
      throw new GuardrailError(
        'Vercel deploy adapter requires `project` (project ID or slug)',
        { code: 'invalid_config', provider: 'vercel' },
      );
    }
    this.token = token;
    this.project = opts.project;
    this.team = opts.team;
    this.target = opts.target ?? 'production';
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.maxPollMs = opts.maxPollMs ?? 15 * 60 * 1000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.nowImpl ?? Date.now;
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const start = this.now();
    const url = this.urlWithTeam(`${VERCEL_API_BASE}/v13/deployments`);
    const body: Record<string, unknown> = {
      name: this.project,
      target: this.target,
      meta: input.meta,
    };
    // Only include gitSource when we have a commitSha — Vercel requires the
    // full {type, repoId, ref} contract for git deploys, which we can't
    // synthesize from a SHA alone in Phase 1. Callers using `commitSha` should
    // also have `VERCEL_PROJECT_ID` linked via `vc link` so Vercel resolves
    // the repo from the linked project.
    if (input.commitSha) {
      body.gitSource = { type: 'github', sha: input.commitSha, ref: input.ref };
    } else if (input.ref) {
      body.gitSource = { type: 'github', ref: input.ref };
    }

    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: input.signal,
    });

    await this.assertOkOrThrow(res, 'create deployment');
    const created = (await res.json()) as VercelDeployResponse;
    if (!created.id) {
      throw new GuardrailError(
        `Vercel returned no deployment id (got: ${JSON.stringify(created).slice(0, 200)})`,
        { code: 'adapter_bug', provider: 'vercel' },
      );
    }
    return this.pollUntilTerminal(created.id, start, input.signal);
  }

  async status(input: DeployStatusInput): Promise<DeployStatusResult> {
    const start = this.now();
    const url = this.urlWithTeam(`${VERCEL_API_BASE}/v13/deployments/${encodeURIComponent(input.deployId)}`);
    const res = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: this.headers(),
      signal: input.signal,
    });
    await this.assertOkOrThrow(res, 'get deployment');
    const data = (await res.json()) as VercelDeployResponse;
    const state = data.readyState ?? data.state;
    const result = this.shapeResult(input.deployId, data, state, this.now() - start);
    return { ...result, deployId: input.deployId };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async pollUntilTerminal(
    deployId: string,
    start: number,
    signal: AbortSignal | undefined,
  ): Promise<DeployResult> {
    const url = this.urlWithTeam(`${VERCEL_API_BASE}/v13/deployments/${encodeURIComponent(deployId)}`);
    while (true) {
      if (signal?.aborted) {
        return { status: 'in-progress', deployId, durationMs: this.now() - start };
      }
      if (this.now() - start > this.maxPollMs) {
        return {
          status: 'in-progress',
          deployId,
          durationMs: this.now() - start,
          buildLogsUrl: this.buildLogsUrl(deployId),
          output: `Deployment still in progress after ${this.maxPollMs}ms — check ${this.buildLogsUrl(deployId)}`,
        };
      }
      const res = await this.fetchWithRetry(url, {
        method: 'GET',
        headers: this.headers(),
        signal,
      });
      await this.assertOkOrThrow(res, 'poll deployment');
      const data = (await res.json()) as VercelDeployResponse;
      const state = data.readyState ?? data.state;
      if (state === 'READY' || state === 'ERROR' || state === 'CANCELED') {
        return this.shapeResult(deployId, data, state, this.now() - start);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private shapeResult(
    deployId: string,
    data: VercelDeployResponse,
    state: VercelState | undefined,
    durationMs: number,
  ): DeployResult {
    const status: DeployResult['status'] =
      state === 'READY' ? 'pass' : state === 'ERROR' || state === 'CANCELED' ? 'fail' : 'in-progress';
    return {
      status,
      deployId,
      deployUrl: data.url ? `https://${data.url}` : undefined,
      buildLogsUrl: this.buildLogsUrl(deployId),
      durationMs,
      output: state ? `Vercel deployment ${deployId}: state=${state}` : undefined,
    };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  private urlWithTeam(base: string): string {
    if (!this.team) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}teamId=${encodeURIComponent(this.team)}`;
  }

  private buildLogsUrl(deployId: string): string {
    const teamSlug = this.team ?? 'me';
    return `https://vercel.com/${encodeURIComponent(teamSlug)}/${encodeURIComponent(this.project)}/${encodeURIComponent(deployId)}`;
  }

  private async assertOkOrThrow(res: Response, step: string): Promise<void> {
    if (res.ok) return;
    const bodyText = await safeReadBody(res);
    if (res.status === 401 || res.status === 403) {
      throw new GuardrailError(
        `Vercel auth failed (${res.status}) on ${step} — check VERCEL_TOKEN scope for project "${this.project}"${this.team ? ` (team ${this.team})` : ''}: ${bodyText}`,
        { code: 'auth', provider: 'vercel', step, details: { status: res.status } },
      );
    }
    if (res.status === 404) {
      throw new GuardrailError(
        `Vercel project "${this.project}" not found (${res.status}) on ${step}: ${bodyText}`,
        { code: 'invalid_config', provider: 'vercel', step, details: { status: res.status } },
      );
    }
    throw new GuardrailError(
      `Vercel API error (${res.status}) on ${step}: ${bodyText}`,
      { code: 'adapter_bug', provider: 'vercel', step, details: { status: res.status } },
    );
  }

  private async fetchWithRetry(url: string, init: RequestInit, attempts = 3, baseMs = 500): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.fetchImpl(url, init);
        // 5xx is transient — retry. 4xx is the caller's problem — fail fast.
        if (res.status >= 500 && res.status < 600 && i < attempts - 1) {
          lastErr = new Error(`HTTP ${res.status}`);
          await this.sleep(baseMs * 2 ** i);
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        // AbortError is intentional cancellation — surface it directly without retry.
        if (err instanceof Error && err.name === 'AbortError') throw err;
        if (i < attempts - 1) {
          await this.sleep(baseMs * 2 ** i);
          continue;
        }
      }
    }
    throw new GuardrailError(
      `Vercel API unreachable after ${attempts} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`,
      { code: 'transient_network', provider: 'vercel' },
    );
  }
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
