// src/adapters/deploy/fly.ts
//
// First-class Fly.io deploy adapter. Phase 1 of the v5.6 spec.
//
// Implements `deploy()` (POST a new release with a pre-pushed image, then
// poll until terminal) and `status()` (one-shot GET). Log streaming is
// Phase 3 (Fly uses WebSockets, not yet wired) and rollback is Phase 4.
//
// All HTTP calls go through an injectable `fetchImpl` so unit tests never
// hit the real Fly Machines API. The endpoint shapes below mirror the
// Codex-reviewed v5.6 spec at docs/specs/v5.6-fly-render-adapters.md and
// will be reconciled with captured fixtures during Phase 2 if the published
// API has drifted; the adapter's surface (auth, error mapping, redaction,
// capability metadata) is stable regardless of which exact body Fly accepts.
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

const FLY_API_BASE = 'https://api.machines.dev';
const FLY_DASHBOARD_BASE = 'https://fly.io/apps';
const FLY_TOKEN_DOC_URL = 'https://fly.io/dashboard/personal/tokens';

/**
 * Fly release lifecycle states.
 *
 * The first three are terminal; the rest are interim.  Fly's actual status
 * vocabulary has evolved across the Nomad → Machines transition; this set
 * is the conservative intersection that maps cleanly onto our
 * `pass | fail | in-progress` tri-state. New states observed in the wild
 * are treated as `in-progress` until the polling budget runs out.
 */
type FlyReleaseState =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'pending'
  | 'running'
  | 'starting';

interface FlyReleaseResponse {
  id: string;
  /** Public hostname (e.g. `my-app.fly.dev`) — Fly returns this on the release. */
  hostname?: string;
  /** Terminal/interim state. */
  status?: FlyReleaseState;
  /** Newer Fly responses use `state`; older use `status`. We accept either. */
  state?: FlyReleaseState;
}

export interface FlyDeployAdapterOptions {
  /** Personal access token. Falls back to `process.env.FLY_API_TOKEN`. */
  token?: string;
  /** Fly app slug. Required. */
  app: string;
  /**
   * Image reference (e.g. `registry.fly.io/my-app:deployment-01`).
   * Required — the adapter never builds; the user pushes via
   * `fly deploy --build-only --push` or equivalent.
   */
  image: string;
  /** Optional region pin. Falls back to the app's default region. */
  region?: string;
  /** Polling interval (ms) when waiting for the release to reach a terminal state. Default: 2000. */
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
 * Fly.io deploy adapter.
 *
 * Construct once per pipeline run. The adapter is stateless across calls —
 * all configuration (token, app, image, region) is captured at construction
 * time. Per the v5.6 spec, only `deploy()` and `status()` are wired in
 * Phase 1; `streamLogs` (WebSocket) and `rollback` (native + simulated)
 * land in Phases 3 and 4 respectively.
 */
export class FlyDeployAdapter implements DeployAdapter {
  readonly name = 'fly';
  readonly capabilities: DeployAdapterCapabilities = {
    streamMode: 'websocket',
    nativeRollback: true,
  };

  private readonly token: string;
  private readonly app: string;
  private readonly image: string;
  private readonly region: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly redactionPatterns: readonly string[] | undefined;

  constructor(opts: FlyDeployAdapterOptions) {
    const token = opts.token ?? process.env.FLY_API_TOKEN;
    if (!token) {
      throw new GuardrailError(
        `Fly deploy adapter requires FLY_API_TOKEN. Create one at ${FLY_TOKEN_DOC_URL}`,
        { code: 'auth', provider: 'fly' },
      );
    }
    if (!opts.app) {
      throw new GuardrailError(
        'Fly deploy adapter requires `app` (Fly app slug)',
        { code: 'invalid_config', provider: 'fly' },
      );
    }
    if (!opts.image) {
      throw new GuardrailError(
        'Fly deploy adapter requires `image` (e.g. registry.fly.io/<app>:<tag>). Push first via `fly deploy --build-only --push`.',
        { code: 'invalid_config', provider: 'fly' },
      );
    }
    this.token = token;
    this.app = opts.app;
    this.image = opts.image;
    this.region = opts.region;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.maxPollMs = opts.maxPollMs ?? 15 * 60 * 1000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.nowImpl ?? Date.now;
    this.redactionPatterns = opts.redactionPatterns;
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const start = this.now();
    const url = `${FLY_API_BASE}/v1/apps/${encodeURIComponent(this.app)}/releases`;
    const body: Record<string, unknown> = {
      image: this.image,
    };
    if (this.region) body.region = this.region;
    if (input.meta) body.meta = input.meta;
    if (input.commitSha) body.commit_sha = input.commitSha;
    if (input.ref) body.ref = input.ref;

    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: input.signal,
    });

    await this.assertOkOrThrow(res, 'create release');
    const created = (await res.json()) as FlyReleaseResponse;
    if (!created.id) {
      throw new GuardrailError(
        `Fly returned no release id (got: ${JSON.stringify(created).slice(0, 200)})`,
        { code: 'adapter_bug', provider: 'fly' },
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
    const url =
      `${FLY_API_BASE}/v1/apps/${encodeURIComponent(this.app)}/releases/${encodeURIComponent(input.deployId)}`;
    const res = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: this.headers(),
      signal: input.signal,
    });
    await this.assertOkOrThrow(res, 'get release');
    const data = (await res.json()) as FlyReleaseResponse;
    const state = data.state ?? data.status;
    const result = this.shapeResult(input.deployId, data, state, this.now() - start);
    return { ...result, deployId: input.deployId };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async pollUntilTerminal(
    releaseId: string,
    start: number,
    signal: AbortSignal | undefined,
  ): Promise<DeployResult> {
    const url =
      `${FLY_API_BASE}/v1/apps/${encodeURIComponent(this.app)}/releases/${encodeURIComponent(releaseId)}`;
    while (true) {
      if (signal?.aborted) {
        return { status: 'in-progress', deployId: releaseId, durationMs: this.now() - start };
      }
      if (this.now() - start > this.maxPollMs) {
        return {
          status: 'in-progress',
          deployId: releaseId,
          durationMs: this.now() - start,
          buildLogsUrl: this.buildLogsUrl(releaseId),
          output: redactLogLines(
            `Fly release still in progress after ${this.maxPollMs}ms — check ${this.buildLogsUrl(releaseId)}`,
            this.redactionPatterns,
          ),
        };
      }
      const res = await this.fetchWithRetry(url, {
        method: 'GET',
        headers: this.headers(),
        signal,
      });
      await this.assertOkOrThrow(res, 'poll release');
      const data = (await res.json()) as FlyReleaseResponse;
      const state = data.state ?? data.status;
      if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
        return this.shapeResult(releaseId, data, state, this.now() - start);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private shapeResult(
    releaseId: string,
    data: FlyReleaseResponse,
    state: FlyReleaseState | undefined,
    durationMs: number,
  ): DeployResult {
    const status: DeployResult['status'] =
      state === 'succeeded'
        ? 'pass'
        : state === 'failed' || state === 'cancelled'
          ? 'fail'
          : 'in-progress';
    // Apply redaction to the human-readable output line. Real-world Fly
    // logs often echo back env vars and tokens; we never want those landing
    // in PR-comment bodies. (Spec § "Log redaction".)
    const rawOutput = state ? `Fly release ${releaseId}: state=${state}` : undefined;
    return {
      status,
      deployId: releaseId,
      deployUrl: data.hostname ? `https://${data.hostname}` : undefined,
      buildLogsUrl: this.buildLogsUrl(releaseId),
      durationMs,
      output: rawOutput !== undefined ? redactLogLines(rawOutput, this.redactionPatterns) : undefined,
    };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  private buildLogsUrl(releaseId: string): string {
    return `${FLY_DASHBOARD_BASE}/${encodeURIComponent(this.app)}/releases/${encodeURIComponent(releaseId)}`;
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
   * The `Fly-Request-Id` response header is captured into `details` whenever
   * present so support tickets can quote it back to Fly.
   */
  private async assertOkOrThrow(res: Response, step: string): Promise<void> {
    if (res.ok) return;
    const bodyText = await safeReadBody(res);
    const requestId = readFlyRequestId(res);
    const details: Record<string, unknown> = { status: res.status };
    if (requestId) details.flyRequestId = requestId;

    if (res.status === 401 || res.status === 403) {
      throw new GuardrailError(
        `Fly auth failed (${res.status}) on ${step} — check FLY_API_TOKEN scope for app "${this.app}". Regenerate at ${FLY_TOKEN_DOC_URL}: ${bodyText}`,
        { code: 'auth', provider: 'fly', step, details },
      );
    }
    if (res.status === 404) {
      throw new GuardrailError(
        `Fly resource not found (${res.status}) on ${step} — app slug "${this.app}" may be wrong, or the release ID belongs to a different app${requestId ? ` (Fly-Request-Id: ${requestId})` : ''}: ${bodyText}`,
        { code: 'not_found', provider: 'fly', step, details },
      );
    }
    if (res.status === 422 || res.status === 400) {
      throw new GuardrailError(
        `Fly rejected the request (${res.status}) on ${step} — likely a bad image reference, missing region, or malformed body: ${bodyText}`,
        { code: 'invalid_config', provider: 'fly', step, details },
      );
    }
    if (res.status >= 500 && res.status < 600) {
      throw new GuardrailError(
        `Fly API server error (${res.status}) on ${step}: ${bodyText}`,
        { code: 'transient_network', provider: 'fly', step, details, retryable: true },
      );
    }
    throw new GuardrailError(
      `Fly API error (${res.status}) on ${step}: ${bodyText}`,
      { code: 'adapter_bug', provider: 'fly', step, details },
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
      `Fly API unreachable after ${attempts} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`,
      { code: 'transient_network', provider: 'fly' },
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
 * Pull `Fly-Request-Id` (case-insensitive) off the response. Fly echoes this
 * header on every API response and support tickets quote it back, so we
 * stash it in `GuardrailError.details.flyRequestId` for any non-OK status.
 *
 * Falls back to `null` when `headers.get` is unavailable (e.g. a stubbed
 * Response in tests that doesn't implement Headers).
 */
function readFlyRequestId(res: Response): string | null {
  const headers = (res as { headers?: { get?: (k: string) => string | null } }).headers;
  if (!headers || typeof headers.get !== 'function') return null;
  return headers.get('Fly-Request-Id') ?? headers.get('fly-request-id') ?? null;
}
