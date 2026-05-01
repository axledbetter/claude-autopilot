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
  DeployLogLine,
  DeployResult,
  DeployRollbackInput,
  DeployStatusInput,
  DeployStatusResult,
  DeployStreamLogsInput,
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
  /**
   * Image reference the release was built from (e.g.
   * `registry.fly.io/my-app:deployment-01`). Surfaced on list-releases
   * responses and used by the simulated-rollback path to re-deploy a
   * known-good image when native `/rollback` is unavailable.
   */
  image?: string;
}

/** Envelope shape for `GET /v1/apps/{app}/releases?limit=N`. Newest-first. */
interface FlyReleasesListResponse {
  releases?: FlyReleaseResponse[];
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
  /**
   * Injected WebSocket constructor for `streamLogs` — defaults to Node 22's
   * built-in `globalThis.WebSocket`. Tests pass a stub that emulates the
   * standard `addEventListener('message' | 'error' | 'close')` surface.
   *
   * Phase 3 of v5.6 — Fly streams build logs over WS with NDJSON-encoded
   * messages. The adapter never imports a WS library; we rely on Node's
   * built-in (Node 22+) for production and the injected stub for unit tests.
   */
  wsImpl?: typeof WebSocket;
  /**
   * Optional override for the Fly log-streaming WebSocket URL builder.
   * Defaults to the spec's stated path (see comment on `streamLogs` for
   * the divergence-from-spec note that Phase 7 will reconcile against
   * captured fixtures). Tests use this to point at a local stub.
   */
  buildLogsWsUrl?: (app: string, releaseId: string) => string;
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
  private readonly wsImpl: typeof WebSocket;
  private readonly buildLogsWsUrlFn: (app: string, releaseId: string) => string;

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
    // Node 22 ships a global `WebSocket`. We don't fall back to a thrown
    // error here — when a caller invokes `streamLogs` and `wsImpl` is
    // undefined we'd surface that there. Most production runtimes have
    // `globalThis.WebSocket` defined; tests inject `wsImpl` directly.
    this.wsImpl = opts.wsImpl ?? (globalThis.WebSocket as typeof WebSocket);
    this.buildLogsWsUrlFn = opts.buildLogsWsUrl ?? defaultFlyLogsWsUrl;
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

  /**
   * Phase 3 of v5.6 — subscribe to real-time build logs for a release via
   * Fly's WebSocket log endpoint.
   *
   * Wire shape:
   * - Connect to `wss://api.machines.dev/v1/apps/{app}/machines/{releaseId}/logs`
   *   (intent-level URL per the v5.6 spec's "Logs" bullet — exact path will
   *   be reconciled against captured fixtures in Phase 7; the `wsImpl` and
   *   `buildLogsWsUrl` injection points keep this overridable until then).
   * - Each WS message is a single NDJSON line containing one log entry.
   *   Multiple lines per message are also tolerated (split on `\n`). Malformed
   *   JSON lines are skipped silently rather than crashing the iterator.
   * - Auth via `Authorization: Bearer <FLY_API_TOKEN>` is passed through the
   *   `protocols` argument (Node's built-in WebSocket doesn't accept custom
   *   `headers` directly the way `ws` does); Fly accepts the token as the
   *   first protocol value. This is the documented pattern for browsers and
   *   matches Node 22's WS surface.
   * - One reconnect with exponential backoff (1s, 2s) on disconnect, then
   *   yield a final `level: 'warn'` line referencing `buildLogsUrl` and
   *   finish the iterator.
   * - `signal.aborted` is honored at every await boundary; the underlying
   *   socket is closed eagerly.
   * - Every yielded line's `text` is run through `redactLogLines()` before
   *   leaving the adapter.
   */
  async *streamLogs(input: DeployStreamLogsInput): AsyncGenerator<DeployLogLine> {
    if (!this.wsImpl) {
      throw new GuardrailError(
        'Fly streamLogs requires a WebSocket implementation (Node 22+ ships one as globalThis.WebSocket; tests can inject `wsImpl`)',
        { code: 'adapter_bug', provider: 'fly' },
      );
    }
    const buildLogsUrl = this.buildLogsUrl(input.deployId);
    let attempt = 0;
    const maxAttempts = 2; // initial + one reconnect, per spec
    while (attempt < maxAttempts) {
      if (input.signal?.aborted) return;
      // Re-build the URL each connection attempt — ensures any caller-side
      // state (counters, freshly-rotated tokens) is sampled per-attempt.
      const url = this.buildLogsWsUrlFn(this.app, input.deployId);
      const queue = new AsyncMessageQueue<DeployLogLine | { __end: true; reason?: string }>();
      let socket: WebSocket;
      try {
        // Fly accepts the API token as the first protocol value — see method
        // doc-comment for why we don't use the `headers` option here.
        socket = new this.wsImpl(url, [this.token]);
      } catch (err) {
        // Constructor threw synchronously (rare — usually for invalid URL).
        // Treat as a disconnect for retry purposes.
        if (attempt === maxAttempts - 1) {
          yield this.redactLine({
            timestamp: this.now(),
            level: 'warn',
            text: `log stream lost — see ${buildLogsUrl} (constructor: ${(err as Error)?.message ?? String(err)})`,
          });
          return;
        }
        attempt += 1;
        await this.sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      const onMessage = (ev: MessageEvent): void => {
        const data = typeof ev.data === 'string' ? ev.data : safeBufferToString(ev.data);
        if (!data) return;
        // NDJSON: one or more newline-separated JSON lines per message.
        for (const raw of data.split('\n')) {
          const line = parseFlyLogLine(raw, this.now());
          if (line) queue.push(line);
        }
      };
      const onError = (_ev: Event): void => {
        // We let `onClose` drive the reconnect/teardown decision — `error`
        // is purely informational on the standard WS surface.
      };
      const onClose = (_ev: CloseEvent): void => {
        queue.push({ __end: true });
      };
      const abortHandler = (): void => {
        try { socket.close(); } catch { /* ignore */ }
        queue.push({ __end: true, reason: 'aborted' });
      };
      socket.addEventListener('message', onMessage as EventListener);
      socket.addEventListener('error', onError as EventListener);
      socket.addEventListener('close', onClose as EventListener);
      input.signal?.addEventListener('abort', abortHandler, { once: true });
      try {
        // Drain messages until the socket closes or signal aborts.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (input.signal?.aborted) return;
          const item = await queue.next();
          if (input.signal?.aborted) return;
          if (item && '__end' in item) {
            if (item.reason === 'aborted') return;
            break; // close → break inner loop, decide reconnect-or-give-up below
          }
          if (item) yield this.redactLine(item);
        }
      } finally {
        socket.removeEventListener('message', onMessage as EventListener);
        socket.removeEventListener('error', onError as EventListener);
        socket.removeEventListener('close', onClose as EventListener);
        input.signal?.removeEventListener('abort', abortHandler);
        try { socket.close(); } catch { /* ignore */ }
      }
      // Closed — decide whether to retry.
      attempt += 1;
      if (attempt >= maxAttempts) {
        yield this.redactLine({
          timestamp: this.now(),
          level: 'warn',
          text: `log stream lost — see ${buildLogsUrl}`,
        });
        return;
      }
      // Exponential backoff: 1s after first close, 2s after second (won't
      // happen given maxAttempts = 2 today, but kept for future tuning).
      const backoffMs = 1000 * 2 ** (attempt - 1);
      await this.sleep(backoffMs);
      if (input.signal?.aborted) return;
    }
  }

  /**
   * Phase 4 of v5.6 — roll back to a previous Fly release.
   *
   * Two modes per spec § "Fly.io adapter → Rollback":
   *
   * 1. Native: try `POST /v1/apps/{app}/releases/{releaseId}/rollback`.
   *    This is the historical Fly API; the Machines-era replacement may
   *    differ — Phase 7 fixture-capture reconciles. If the endpoint returns
   *    404 / 405 / 410 (removed across the Nomad → Machines transition),
   *    fall through to the simulated path. Any other non-OK status
   *    (auth, invalid_config, etc.) propagates via `assertOkOrThrow`.
   *
   * 2. Simulated: list prior releases via
   *    `GET /v1/apps/{app}/releases?limit=10`, find the most recent one
   *    with `status === 'succeeded'` whose `id` differs from the one we'd
   *    be rolling back from, and trigger a new deploy with that release's
   *    `image`. Re-uses the same POST + poll machinery as `deploy()` via
   *    `deployImage()`.
   *
   * When `input.to` is set we treat that as a specific release ID:
   * - Native path uses it as the URL fragment.
   * - Simulated path looks it up in the list to grab its `image`. If the
   *   release is not present in the recent-10 window, throw
   *   `not_found` — caller almost certainly typo'd the ID.
   *
   * Throws `GuardrailError({ code: 'no_previous_deploy', provider: 'fly' })`
   * when the simulated path runs out of candidates (i.e. no prior release
   * with `status === 'succeeded'` exists).
   */
  async rollback(input: DeployRollbackInput): Promise<DeployResult> {
    const start = this.now();

    // ── Native path ──
    // When `to` is set, we have a concrete release ID to target. When it's
    // not, we still attempt the native verb on the *previous* release we
    // discover via the list endpoint — same call shape, just one indirection.
    let nativeTargetId = input.to;
    let prevImage: string | undefined;
    if (!nativeTargetId) {
      const prev = await this.findPreviousSucceededRelease(undefined, input.signal);
      if (!prev) {
        throw new GuardrailError(
          `No previous successful Fly release found for app "${this.app}" to roll back to`,
          { code: 'no_previous_deploy', provider: 'fly' },
        );
      }
      nativeTargetId = prev.id;
      prevImage = prev.image;
    }

    const nativeUrl =
      `${FLY_API_BASE}/v1/apps/${encodeURIComponent(this.app)}/releases/${encodeURIComponent(nativeTargetId)}/rollback`;
    let nativeRes: Response;
    try {
      nativeRes = await this.fetchWithRetry(nativeUrl, {
        method: 'POST',
        headers: this.headers(),
        body: '{}',
        signal: input.signal,
      });
    } catch (err) {
      // Network exhaustion is already mapped to GuardrailError(transient_network)
      // by fetchWithRetry — rethrow.
      throw err;
    }

    if (nativeRes.ok) {
      let data: FlyReleaseResponse | undefined;
      try {
        data = (await nativeRes.json()) as FlyReleaseResponse;
      } catch {
        data = undefined;
      }
      const rawOutput = `Fly release ${nativeTargetId} rolled back natively for app "${this.app}"`;
      return {
        status: 'pass',
        deployId: nativeTargetId,
        rolledBackTo: nativeTargetId,
        deployUrl: data?.hostname ? `https://${data.hostname}` : undefined,
        buildLogsUrl: this.buildLogsUrl(nativeTargetId),
        durationMs: this.now() - start,
        output: redactLogLines(rawOutput, this.redactionPatterns),
      };
    }

    // ── Simulated fallback ──
    // The native rollback verb has been removed from the Machines API in
    // some org/region pairs. 404 (endpoint removed), 405 (method now
    // disallowed), and 410 (gone) all indicate "use the simulated path".
    // Anything else — auth, validation, 5xx exhaustion — propagates.
    if (nativeRes.status !== 404 && nativeRes.status !== 405 && nativeRes.status !== 410) {
      await this.assertOkOrThrow(nativeRes, 'native rollback');
      // assertOkOrThrow always throws for non-OK responses; this is unreachable
      // but keeps the type checker happy.
      throw new GuardrailError(
        `Fly native rollback returned non-OK ${nativeRes.status} (unreachable)`,
        { code: 'adapter_bug', provider: 'fly' },
      );
    }

    // Simulated rollback: re-deploy a previous successful image.
    let imageToDeploy: string | undefined;
    let simulatedTargetId: string | undefined;
    if (input.to) {
      // Look up the user-specified release in the recent window to grab its
      // image. We search by id rather than re-using `prevImage` (which is
      // unset when `input.to` was provided).
      const releases = await this.listReleases(10, input.signal);
      const match = releases.find((r) => r.id === input.to);
      if (!match) {
        throw new GuardrailError(
          `Fly release "${input.to}" not found in the last 10 releases for app "${this.app}" — cannot simulate rollback`,
          { code: 'not_found', provider: 'fly', step: 'simulated rollback' },
        );
      }
      if (!match.image) {
        throw new GuardrailError(
          `Fly release "${input.to}" has no recorded image — cannot simulate rollback`,
          { code: 'invalid_config', provider: 'fly', step: 'simulated rollback' },
        );
      }
      imageToDeploy = match.image;
      simulatedTargetId = match.id;
    } else {
      // We already discovered the previous successful release before the
      // native attempt; reuse its image when present, otherwise re-list.
      if (prevImage) {
        imageToDeploy = prevImage;
        simulatedTargetId = nativeTargetId;
      } else {
        const prev = await this.findPreviousSucceededRelease(undefined, input.signal);
        if (!prev) {
          throw new GuardrailError(
            `No previous successful Fly release found for app "${this.app}" to roll back to`,
            { code: 'no_previous_deploy', provider: 'fly' },
          );
        }
        if (!prev.image) {
          throw new GuardrailError(
            `Previous Fly release "${prev.id}" has no recorded image — cannot simulate rollback`,
            { code: 'invalid_config', provider: 'fly', step: 'simulated rollback' },
          );
        }
        imageToDeploy = prev.image;
        simulatedTargetId = prev.id;
      }
    }

    const redeployed = await this.deployImage(imageToDeploy, input.signal);
    const rawOutput = `Fly rollback simulated by re-deploying image "${imageToDeploy}" (prior release ${simulatedTargetId}) → new release ${redeployed.deployId ?? '<unknown>'}`;
    return {
      ...redeployed,
      // Carry the new release id forward as `deployId` (we just deployed it),
      // and flag the prior release as the rollback target so the CLI can
      // surface "rolled back to X (new deploy Y)".
      rolledBackTo: simulatedTargetId,
      durationMs: this.now() - start,
      output: redactLogLines(rawOutput, this.redactionPatterns),
    };
  }

  /**
   * Private helper — re-uses the deploy() POST + poll machinery to deploy a
   * specific image without going through the constructor-stamped image. Used
   * by `rollback()`'s simulated path to redeploy a previous successful image.
   */
  private async deployImage(image: string, signal: AbortSignal | undefined): Promise<DeployResult> {
    const start = this.now();
    const url = `${FLY_API_BASE}/v1/apps/${encodeURIComponent(this.app)}/releases`;
    const body: Record<string, unknown> = { image };
    if (this.region) body.region = this.region;
    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    await this.assertOkOrThrow(res, 'create release (rollback)');
    const created = (await res.json()) as FlyReleaseResponse;
    if (!created.id) {
      throw new GuardrailError(
        `Fly returned no release id during rollback (got: ${JSON.stringify(created).slice(0, 200)})`,
        { code: 'adapter_bug', provider: 'fly' },
      );
    }
    return this.pollUntilTerminal(created.id, start, signal);
  }

  /**
   * List the most recent releases for the configured app. Newest-first.
   * `limit` caps the result set — defaults to 10 (the spec's recommended
   * window for the rollback lookup). 4xx/5xx errors propagate via
   * `assertOkOrThrow`.
   */
  async listReleases(limit = 10, signal?: AbortSignal): Promise<FlyReleaseResponse[]> {
    const url =
      `${FLY_API_BASE}/v1/apps/${encodeURIComponent(this.app)}/releases?limit=${encodeURIComponent(String(limit))}`;
    const res = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: this.headers(),
      signal,
    });
    await this.assertOkOrThrow(res, 'list releases');
    const data = (await res.json()) as FlyReleasesListResponse | FlyReleaseResponse[];
    // Be defensive — Fly has shipped both list-envelope and bare-array
    // shapes across API generations.
    const arr = Array.isArray(data) ? data : Array.isArray(data?.releases) ? data.releases : [];
    return arr;
  }

  /**
   * Find the most recent prior release with `status === 'succeeded'`. When
   * `excludeId` is supplied, that release is skipped (used to ensure
   * `rollback()` never returns "rolled back to the deploy I'm rolling back
   * from" when the caller didn't supply `input.to`).
   *
   * Returns `null` when no candidate exists.
   */
  private async findPreviousSucceededRelease(
    excludeId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<FlyReleaseResponse | null> {
    const releases = await this.listReleases(10, signal);
    // Fly returns newest-first; the first `succeeded` entry is the current
    // prod release. When `excludeId` is unset we still want the *previous*
    // succeeded release — drop the first match and return the next.
    const succeeded = releases.filter((r) => {
      const state = r.state ?? r.status;
      if (state !== 'succeeded') return false;
      if (excludeId && r.id === excludeId) return false;
      return true;
    });
    if (excludeId) {
      // Caller already filtered out the rollback-from id; return the newest
      // remaining succeeded release.
      return succeeded[0] ?? null;
    }
    // No exclude — drop the head (current prod) and return the next.
    if (succeeded.length < 2) return null;
    return succeeded[1] ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Apply the adapter's redaction patterns to a log line's `text` field.
   * Pure helper — keeps the streamLogs loop readable.
   */
  private redactLine(line: DeployLogLine): DeployLogLine {
    return { ...line, text: redactLogLines(line.text, this.redactionPatterns) };
  }

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

/**
 * Default WebSocket URL builder for Fly log streaming.
 *
 * The URL shape below is intent-level per the v5.6 spec § "Fly.io adapter →
 * Logs":
 *
 *     wss://api.machines.dev/v1/apps/{app}/machines/{machineId}/logs
 *
 * Phase 7 of v5.6 reconciles this against captured fixtures from a real
 * Fly account. If the published path differs (e.g. `/releases/{id}/logs` or
 * a different host), we'll update this builder there. Until then, callers
 * who hit a divergent path can pass `buildLogsWsUrl` to override.
 *
 * Note: we treat the `deployId` (release id) as the machine id for now —
 * Fly's deploy → release → machine mapping is not 1:1 in all cases, and
 * Phase 7 will need to either look up the machine list before subscribing
 * or use a different log endpoint that takes a release id directly.
 */
function defaultFlyLogsWsUrl(app: string, releaseId: string): string {
  // wss base mirrors FLY_API_BASE but with a `wss://` scheme.
  return `wss://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(releaseId)}/logs`;
}

/**
 * Best-effort decoder for the binary `data` field of a `MessageEvent`.
 * Fly normally sends UTF-8 text; tests may pass a Buffer or Uint8Array.
 */
function safeBufferToString(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
    return new TextDecoder('utf-8').decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (typeof (data as { toString?: () => string }).toString === 'function') {
    return (data as { toString: () => string }).toString();
  }
  return '';
}

/**
 * Parse a single NDJSON log line from Fly's WS stream into a `DeployLogLine`.
 *
 * Fly wraps log entries in objects whose canonical shape is roughly
 * `{ timestamp: <epoch_ms>, level: 'info' | 'warn' | 'error', message: '<text>' }`.
 * We accept both `message` and `text` (older Fly clients use the latter).
 * Lines that fail to JSON-parse OR that have no usable text return `null`,
 * which the caller drops silently — never crash a long-running stream.
 */
function parseFlyLogLine(raw: string, fallbackTs: number): DeployLogLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not all lines are JSON — Fly occasionally emits raw text (e.g. boot
    // banners). Surface those as plain stdout entries.
    return { timestamp: fallbackTs, level: 'info', text: trimmed };
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { timestamp?: number; ts?: number; level?: string; message?: string; text?: string };
  const text = typeof obj.message === 'string' ? obj.message : typeof obj.text === 'string' ? obj.text : '';
  if (!text) return null;
  const ts = typeof obj.timestamp === 'number'
    ? obj.timestamp
    : typeof obj.ts === 'number' ? obj.ts : fallbackTs;
  return { timestamp: ts, level: obj.level, text };
}

/**
 * Tiny FIFO queue with an awaitable `next()`. Backs the WS event-pump → async
 * generator bridge in `streamLogs`. Resolves promises in push order; if the
 * queue is empty, `next()` returns a promise that resolves on the next push.
 */
class AsyncMessageQueue<T> {
  private readonly buffer: T[] = [];
  private waiter: ((v: T) => void) | null = null;

  push(item: T): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
      return;
    }
    this.buffer.push(item);
  }

  next(): Promise<T> {
    const head = this.buffer.shift();
    if (head !== undefined) return Promise.resolve(head);
    return new Promise<T>((resolve) => {
      this.waiter = resolve;
    });
  }
}
