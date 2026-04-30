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
  DeployLogLine,
  DeployResult,
  DeployStatusInput,
  DeployStatusResult,
  DeployStreamLogsInput,
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
    // Phase 2: fire onDeployStart so callers (e.g. --watch) can subscribe
    // to logs in parallel with polling. Wrap in try/catch — a buggy callback
    // must not crash the deploy.
    try {
      input.onDeployStart?.(created.id);
    } catch {
      /* swallow — observability concern only */
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

  /**
   * Phase 2 — subscribe to real-time build logs for a deployment.
   *
   * Streams `GET /v2/deployments/<id>/events?builds=1&follow=1` and yields a
   * `DeployLogLine` for each `stdout` / `stderr` event. Lifecycle events
   * (`state`, `complete`) are filtered out — the polling loop in `deploy()`
   * already handles them. Malformed JSON lines are skipped silently rather
   * than crashing a long-running stream.
   *
   * Cancellation: pass `input.signal`. Once aborted, the underlying fetch
   * is torn down and the iterator returns.
   */
  async *streamLogs(input: DeployStreamLogsInput): AsyncGenerator<DeployLogLine> {
    const url = this.urlWithTeam(
      `${VERCEL_API_BASE}/v2/deployments/${encodeURIComponent(input.deployId)}/events?builds=1&follow=1`,
    );
    const res = await this.fetchEventsWithRetry(url, input.signal);
    await this.assertOkOrThrow(res, 'stream logs');
    if (!res.body) {
      throw new GuardrailError(
        `Vercel events response had no body for ${input.deployId}`,
        { code: 'adapter_bug', provider: 'vercel' },
      );
    }
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
      while (true) {
        if (input.signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) {
          // Flush a trailing partial line if present.
          if (buf.length > 0) {
            const line = parseEventLine(buf);
            if (line) yield line;
          }
          return;
        }
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const raw = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const line = parseEventLine(raw);
          if (line) yield line;
          nl = buf.indexOf('\n');
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
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

  /**
   * Like `fetchWithRetry` but tuned for the events endpoint:
   * - 404 right after a deploy POST is a known race (the deploy hasn't yet
   *   propagated to the events service). Retry up to N times with backoff.
   * - 5xx behaves the same as `fetchWithRetry`.
   * - Cancels cleanly on AbortError.
   * - Returns the last `Response` so the caller can `assertOkOrThrow` on a
   *   final non-OK status (e.g. 401 still bubbles immediately on attempt 1).
   */
  private async fetchEventsWithRetry(
    url: string,
    signal: AbortSignal | undefined,
    attempts = 3,
    baseMs = 500,
  ): Promise<Response> {
    let lastRes: Response | undefined;
    for (let i = 0; i < attempts; i++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { ...this.headers(), Accept: 'text/event-stream' },
          signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        if (i < attempts - 1) {
          await this.sleep(baseMs * 2 ** i);
          continue;
        }
        throw new GuardrailError(
          `Vercel events endpoint unreachable after ${attempts} attempts: ${(err as Error)?.message ?? String(err)}`,
          { code: 'transient_network', provider: 'vercel' },
        );
      }
      lastRes = res;
      // 404 after create-deployment is the known race — retry.
      if (res.status === 404 && i < attempts - 1) {
        await this.sleep(baseMs * 2 ** i);
        continue;
      }
      // 5xx is transient — retry.
      if (res.status >= 500 && res.status < 600 && i < attempts - 1) {
        await this.sleep(baseMs * 2 ** i);
        continue;
      }
      return res;
    }
    return lastRes!;
  }
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

/**
 * Parse a single line from Vercel's events endpoint into a `DeployLogLine`.
 *
 * Accepts both raw NDJSON and classic SSE `data: {...}` lines. Returns
 * `null` for events we don't surface (state changes, completes, heartbeats,
 * and any line that fails to JSON-parse) — silently skipping a malformed
 * event is preferable to crashing a long-running stream.
 */
function parseEventLine(raw: string): DeployLogLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // SSE comment / heartbeat lines start with ':'
  if (trimmed.startsWith(':')) return null;
  // SSE event/id/retry lines — not data, skip
  if (trimmed.startsWith('event:') || trimmed.startsWith('id:') || trimmed.startsWith('retry:')) return null;
  // Strip 'data: ' prefix if present (classic SSE)
  const jsonPart = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!jsonPart) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const ev = parsed as { type?: string; payload?: { text?: string }; created?: number; date?: number };
  // Only surface log-bearing event types. Vercel emits 'stdout'/'stderr' for
  // build output; 'state'/'complete'/etc. are deploy lifecycle events that
  // the polling loop already handles.
  if (ev.type !== 'stdout' && ev.type !== 'stderr') return null;
  const text = typeof ev.payload?.text === 'string' ? ev.payload.text : '';
  if (!text) return null;
  const ts = typeof ev.created === 'number' ? ev.created : typeof ev.date === 'number' ? ev.date : Date.now();
  return { timestamp: ts, level: ev.type, text };
}
