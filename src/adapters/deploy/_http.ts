// src/adapters/deploy/_http.ts
//
// Shared HTTP plumbing extracted in v5.6 Phase 5 — see
// docs/specs/v5.6-fly-render-adapters.md § "Implementation phases".
//
// Three identical copies of `fetchWithRetry` and `safeReadBody` lived in
// `vercel.ts`, `fly.ts`, and `render.ts` before this module existed. Phase 5
// consolidates them as free functions so each adapter imports them as
// HTTP plumbing without `this` context. The deliberate decision (per the
// spec and PR #72 review) was to wait until a third copy materialized
// before reaching for shared abstractions, so each adapter's seam was
// settled.
//
// Out of scope on purpose:
// - `assertOkOrThrow` style HTTP-status mappers stay per-adapter. Each one
//   composes a different error message (auth-token doc URL, 422 hint copy)
//   and reads a different request-id header (`Fly-Request-Id` vs
//   `x-request-id`). Sharing those would force a configuration object that's
//   bigger than the function it replaces.
// - The Vercel `fetchEventsWithRetry` SSE helper is still adapter-private —
//   it has different retry rules (404 race retried, 5xx retried with
//   different shape) and returns the last response rather than throwing on
//   exhaustion.

import { GuardrailError } from '../../core/errors.ts';

/**
 * Options for {@link fetchWithRetry}. `provider` is mandatory — it's the
 * value baked into the `GuardrailError` thrown when retries exhaust, so
 * callers must always identify themselves. `attempts`, `baseMs`, and
 * `sleepImpl` are tuning knobs with sensible defaults that match the
 * pre-extraction behavior of all three adapters.
 */
export interface FetchWithRetryOptions {
  /** Adapter name baked into the GuardrailError thrown on exhaustion. */
  provider: string;
  /** Max attempts (inclusive). Default: 3. */
  attempts?: number;
  /** Base backoff in ms — exponential per attempt. Default: 500. */
  baseMs?: number;
  /** Injected sleep — adapters pass `this.sleep` so tests stay instant. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Free-function port of the per-adapter `fetchWithRetry` helper. Behavior
 * is intentionally identical to the previous private copies:
 * - 5xx responses are retried with exponential backoff (`baseMs * 2 ** i`).
 * - 4xx responses are returned as-is so the per-adapter `assertOkOrThrow`
 *   can classify them precisely (auth vs not_found vs invalid_config).
 * - Network errors are retried unless `AbortError`, which is rethrown so
 *   intentional cancellation is never silently retried.
 * - On exhaustion, throws `GuardrailError({ code: 'transient_network',
 *   provider })` with the last error's message embedded.
 *
 * Adapters call this as `await fetchWithRetry(this.fetchImpl, url, init,
 * { sleepImpl: this.sleep, provider: 'fly' })` — passing both the fetch
 * implementation and the sleep impl explicitly keeps the adapter's
 * `nowImpl`/`sleepImpl` injection points working for tests.
 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions,
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const sleep = opts.sleepImpl ?? DEFAULT_SLEEP;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, init);
      // 5xx is transient — retry. 4xx is the caller's problem — fail fast
      // so the per-adapter error mapper can classify it precisely.
      if (res.status >= 500 && res.status < 600 && i < attempts - 1) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(baseMs * 2 ** i);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      // AbortError is intentional cancellation — surface it directly without
      // retry. Wrapping or retrying would silently defeat caller-side
      // cancellation.
      if (err instanceof Error && err.name === 'AbortError') throw err;
      if (i < attempts - 1) {
        await sleep(baseMs * 2 ** i);
        continue;
      }
    }
  }
  throw new GuardrailError(
    `${capitalize(opts.provider)} API unreachable after ${attempts} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`,
    { code: 'transient_network', provider: opts.provider },
  );
}

/**
 * Read at most 500 bytes of a `Response` body as text. Used by the
 * per-adapter `assertOkOrThrow` helpers to embed the API's error body in
 * the thrown `GuardrailError` for debugging without dumping multi-MB HTML
 * pages. Returns `<no body>` if the body is unreadable (e.g. already
 * consumed, network error mid-read).
 */
export async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

/**
 * Title-case the first letter of an adapter name so the exhaustion error
 * reads "Vercel API unreachable…" instead of "vercel API unreachable…",
 * matching the wording of the pre-extraction copies.
 */
function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
