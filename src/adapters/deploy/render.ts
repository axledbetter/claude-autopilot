// src/adapters/deploy/render.ts
//
// First-class Render deploy adapter. Phase 2 of the v5.6 spec.
//
// Implements `deploy()` (POST a new deploy on a configured service, then
// poll until terminal) and `status()` (one-shot GET). Log streaming is
// Phase 3 (Render uses REST polling, lands later) and rollback is Phase 4
// (simulated by re-deploying the previous successful commit — Render has
// no native rollback verb).
//
// All HTTP calls go through an injectable `fetchImpl` so unit tests never
// hit the real Render API. The endpoint shapes below mirror the Render REST
// API as documented at https://api-docs.render.com/.
//
// Design note (Phase 5 refactor pending): the `fetchWithRetry` /
// `safeReadBody` / error-mapping helpers are intentionally duplicated from
// `fly.ts`. Bugbot flagged this on Phase 1; we deliberately deferred a
// shared HTTP-helper module to Phase 5 once both adapters exist and we can
// see exactly which seams are common vs adapter-specific. Touching the
// shared layer mid-Phase-2 risks destabilizing Phase 1 and is out of scope.
//
// Spec: docs/specs/v5.6-fly-render-adapters.md

import { GuardrailError } from '../../core/errors.ts';
import { redactLogLines } from '../../core/logging/redaction.ts';
import type {
  DeployAdapter,
  DeployAdapterCapabilities,
  DeployInput,
  DeployResult,
  DeployStatusInput,
  DeployStatusResult,
} from './types.ts';

const RENDER_API_BASE = 'https://api.render.com';
const RENDER_DASHBOARD_BASE = 'https://dashboard.render.com';
const RENDER_TOKEN_DOC_URL = 'https://dashboard.render.com/u/settings#api-keys';

/**
 * Render deploy lifecycle states (per https://api-docs.render.com/).
 *
 * Terminal: `live` (success), `deactivated` / `build_failed` /
 * `update_failed` / `canceled` (failure). Everything else is interim and
 * maps to `in-progress` until the polling budget runs out.
 *
 * Render's API has accreted state names over time; new states observed in
 * the wild are treated as `in-progress` rather than guessing pass/fail.
 */
type RenderDeployStatus =
  | 'created'
  | 'build_in_progress'
  | 'update_in_progress'
  | 'live'
  | 'deactivated'
  | 'build_failed'
  | 'update_failed'
  | 'canceled';

interface RenderDeployResponse {
  id: string;
  /** Commit SHA the deploy is built from — Render returns this on every deploy object. */
  commit?: { id?: string; message?: string };
  /** Lifecycle state. */
  status?: RenderDeployStatus;
}

export interface RenderDeployAdapterOptions {
  /** Render API key. Falls back to `process.env.RENDER_API_KEY`. */
  token?: string;
  /** Render service ID (e.g. `srv-abc123`). Required. */
  serviceId: string;
  /**
   * Whether Render should clear the build cache before deploying.
   * Default: `'do_not_clear'`. Maps to the API body field 1:1.
   */
  clearCache?: 'do_not_clear' | 'clear';
  /** Polling interval (ms) when waiting for the deploy to reach a terminal state. Default: 2000. */
  pollIntervalMs?: number;
  /** Maximum total time to poll before returning `in-progress`. Default: 15 minutes. */
  maxPollMs?: number;
  /** Injected fetch implementation — defaults to `globalThis.fetch`. Tests pass a mock. */
  fetchImpl?: typeof fetch;
  /** Injected sleep implementation — tests pass a no-op so they don't actually wait. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Wall-clock source — tests pass a controllable counter. */
  nowImpl?: () => number;
  /**
   * Optional caller-supplied redaction patterns (in addition to the
   * built-in default set in `core/logging/redaction.ts`). Typically wired
   * from `config.persistence.redactionPatterns` by the CLI; tests omit it.
   */
  redactionPatterns?: readonly string[];
}

/**
 * Render deploy adapter.
 *
 * Construct once per pipeline run. The adapter is stateless across calls —
 * all configuration (token, serviceId, clearCache) is captured at
 * construction time. Per the v5.6 spec, only `deploy()` and `status()` are
 * wired in Phase 2; `streamLogs` (REST polling) and `rollback` (simulated
 * via re-deploy) land in Phases 3 and 4 respectively.
 */
export class RenderDeployAdapter implements DeployAdapter {
  readonly name = 'render';
  readonly capabilities: DeployAdapterCapabilities = {
    streamMode: 'polling',
    nativeRollback: false,
  };

  private readonly token: string;
  private readonly serviceId: string;
  private readonly clearCache: 'do_not_clear' | 'clear';
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly redactionPatterns: readonly string[] | undefined;

  constructor(opts: RenderDeployAdapterOptions) {
    const token = opts.token ?? process.env.RENDER_API_KEY;
    if (!token) {
      throw new GuardrailError(
        `Render deploy adapter requires RENDER_API_KEY. Create one at ${RENDER_TOKEN_DOC_URL}`,
        { code: 'auth', provider: 'render' },
      );
    }
    if (!opts.serviceId) {
      throw new GuardrailError(
        'Render deploy adapter requires `serviceId` (Render service ID, e.g. srv-abc123)',
        { code: 'invalid_config', provider: 'render' },
      );
    }
    this.token = token;
    this.serviceId = opts.serviceId;
    this.clearCache = opts.clearCache ?? 'do_not_clear';
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.maxPollMs = opts.maxPollMs ?? 15 * 60 * 1000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.nowImpl ?? Date.now;
    this.redactionPatterns = opts.redactionPatterns;
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const start = this.now();
    const url = `${RENDER_API_BASE}/v1/services/${encodeURIComponent(this.serviceId)}/deploys`;
    const body: Record<string, unknown> = {
      clearCache: this.clearCache,
    };
    // Render accepts `commitId` to deploy a specific commit — useful both
    // for normal deploys driven by a SHA and for the eventual Phase 4
    // simulated-rollback path that re-deploys a previous commit.
    if (input.commitSha) body.commitId = input.commitSha;

    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: input.signal,
    });

    await this.assertOkOrThrow(res, 'create deploy');
    const created = (await res.json()) as RenderDeployResponse;
    if (!created.id) {
      throw new GuardrailError(
        `Render returned no deploy id (got: ${JSON.stringify(created).slice(0, 200)})`,
        { code: 'adapter_bug', provider: 'render' },
      );
    }
    // Fire onDeployStart so callers can subscribe to side-channel work
    // (log streaming once Phase 3 lands) in parallel with polling. Wrap in
    // try/catch — a buggy callback must not crash the deploy.
    try {
      input.onDeployStart?.(created.id);
    } catch {
      /* swallow — observability concern only */
    }
    return this.pollUntilTerminal(created.id, start, input.signal);
  }

  async status(input: DeployStatusInput): Promise<DeployStatusResult> {
    const start = this.now();
    const url = `${RENDER_API_BASE}/v1/deploys/${encodeURIComponent(input.deployId)}`;
    const res = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: this.headers(),
      signal: input.signal,
    });
    await this.assertOkOrThrow(res, 'get deploy');
    const data = (await res.json()) as RenderDeployResponse;
    const result = this.shapeResult(input.deployId, data, data.status, this.now() - start);
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
    const url = `${RENDER_API_BASE}/v1/deploys/${encodeURIComponent(deployId)}`;
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
          output: redactLogLines(
            `Render deploy still in progress after ${this.maxPollMs}ms — check ${this.buildLogsUrl(deployId)}`,
            this.redactionPatterns,
          ),
        };
      }
      const res = await this.fetchWithRetry(url, {
        method: 'GET',
        headers: this.headers(),
        signal,
      });
      await this.assertOkOrThrow(res, 'poll deploy');
      const data = (await res.json()) as RenderDeployResponse;
      const status = data.status;
      if (
        status === 'live'
        || status === 'build_failed'
        || status === 'update_failed'
        || status === 'canceled'
        || status === 'deactivated'
      ) {
        return this.shapeResult(deployId, data, status, this.now() - start);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private shapeResult(
    deployId: string,
    data: RenderDeployResponse,
    status: RenderDeployStatus | undefined,
    durationMs: number,
  ): DeployResult {
    // Map Render's eight-state vocabulary onto our pass/fail/in-progress
    // tri-state. `live` is the only success terminal; `deactivated`,
    // `build_failed`, `update_failed`, `canceled` are failure terminals;
    // everything else is interim.
    const resultStatus: DeployResult['status'] =
      status === 'live'
        ? 'pass'
        : status === 'build_failed'
            || status === 'update_failed'
            || status === 'canceled'
            || status === 'deactivated'
          ? 'fail'
          : 'in-progress';
    // Apply redaction to the human-readable output line. Real-world Render
    // logs often echo back env vars and tokens; we never want those landing
    // in PR-comment bodies. (Spec § "Log redaction".)
    const commitInfo = data.commit?.id ? ` commit=${data.commit.id}` : '';
    const rawOutput = status ? `Render deploy ${deployId}: status=${status}${commitInfo}` : undefined;
    return {
      status: resultStatus,
      deployId,
      buildLogsUrl: this.buildLogsUrl(deployId),
      durationMs,
      output: rawOutput !== undefined ? redactLogLines(rawOutput, this.redactionPatterns) : undefined,
    };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private buildLogsUrl(deployId: string): string {
    return `${RENDER_DASHBOARD_BASE}/web/${encodeURIComponent(this.serviceId)}/deploys/${encodeURIComponent(deployId)}`;
  }

  /**
   * HTTP-status-keyed error mapper. Per v5.6 spec:
   *
   * | Status | ErrorCode |
   * |---|---|
   * | 401 / 403 | `auth` |
   * | 404 | `not_found` |
   * | 422 / 400 | `invalid_config` |
   * | 5xx | `transient_network` (retryable) |
   * | other 4xx | `adapter_bug` |
   *
   * Render echoes a request-id on the `x-request-id` header on most
   * responses. We capture it into `details.renderRequestId` whenever
   * present so support tickets can quote it back to Render.
   */
  private async assertOkOrThrow(res: Response, step: string): Promise<void> {
    if (res.ok) return;
    const bodyText = await safeReadBody(res);
    const requestId = readRenderRequestId(res);
    const details: Record<string, unknown> = { status: res.status };
    if (requestId) details.renderRequestId = requestId;

    if (res.status === 401 || res.status === 403) {
      throw new GuardrailError(
        `Render auth failed (${res.status}) on ${step} — check RENDER_API_KEY scope for service "${this.serviceId}". Regenerate at ${RENDER_TOKEN_DOC_URL}: ${bodyText}`,
        { code: 'auth', provider: 'render', step, details },
      );
    }
    if (res.status === 404) {
      throw new GuardrailError(
        `Render resource not found (${res.status}) on ${step} — service ID "${this.serviceId}" may be wrong, or the deploy ID belongs to a different service${requestId ? ` (x-request-id: ${requestId})` : ''}: ${bodyText}`,
        { code: 'not_found', provider: 'render', step, details },
      );
    }
    if (res.status === 422 || res.status === 400) {
      throw new GuardrailError(
        `Render rejected the request (${res.status}) on ${step} — likely a malformed serviceId, invalid clearCache value, or unknown commitId: ${bodyText}`,
        { code: 'invalid_config', provider: 'render', step, details },
      );
    }
    if (res.status >= 500 && res.status < 600) {
      throw new GuardrailError(
        `Render API server error (${res.status}) on ${step}: ${bodyText}`,
        { code: 'transient_network', provider: 'render', step, details, retryable: true },
      );
    }
    throw new GuardrailError(
      `Render API error (${res.status}) on ${step}: ${bodyText}`,
      { code: 'adapter_bug', provider: 'render', step, details },
    );
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    attempts = 3,
    baseMs = 500,
  ): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.fetchImpl(url, init);
        // 5xx is transient — retry. 4xx is the caller's problem — fail fast
        // so the error mapper above can classify it precisely.
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
      `Render API unreachable after ${attempts} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`,
      { code: 'transient_network', provider: 'render' },
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

/**
 * Pull `x-request-id` (case-insensitive) off the response. Render echoes
 * this header on most API responses; capturing it into
 * `GuardrailError.details.renderRequestId` lets users quote it back when
 * filing support tickets.
 *
 * Falls back to `null` when `headers.get` is unavailable (e.g. a stubbed
 * Response in tests that doesn't implement Headers).
 */
function readRenderRequestId(res: Response): string | null {
  const headers = (res as { headers?: { get?: (k: string) => string | null } }).headers;
  if (!headers || typeof headers.get !== 'function') return null;
  return headers.get('x-request-id') ?? headers.get('X-Request-Id') ?? null;
}
