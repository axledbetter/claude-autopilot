// tests/adapters/live/_harness.ts
//
// Shared test harness for the Phase 7 live adapter certification suite.
//
// Spec: docs/specs/v6-run-state-engine.md § "Real adapter certification suite (Phase 7)"
//
// What this module owns
// ---------------------
// 1. **Env-gated skip** — every cert test asks the harness whether the
//    provider has a `*_TOKEN_TEST` / `*_API_KEY_TEST` env var. If not, the
//    test calls `t.skip()` and exits cleanly. This is the dominant case
//    on dev machines and CI today (no live credentials are configured
//    yet — see docs/adapters/cert-suite.md).
// 2. **Retry budget** — transient categories (5xx, rate-limit, network)
//    get up to 3 attempts with exp backoff (1s / 4s / 16s, scaled by an
//    injectable `sleepImpl` so the unit tests run instantly).
// 3. **Hard-fail vs soft-fail classification.** Per spec:
//    - hard-fail (no retry): `auth`, `not_found`, schema mismatch.
//    - soft-fail with alert: rollout / log-streaming flakes. Three
//      consecutive soft-fails on the same check escalate to hard-fail.
// 4. **Artifact paths.** Every cert run gets a deterministic
//    `<artifactRoot>/<provider>/<runId>/{events.ndjson,log-tail.txt}`
//    path. Workflow uploads them so a triage engineer can replay a
//    failure without re-running the workflow (~200 log-line tail).
// 5. **NDJSON event sink.** The harness writes one event line per
//    check decision (`check.start`, `check.attempt`, `check.success`,
//    `check.soft-fail`, `check.hard-fail`, `check.skipped`) so a
//    consumer can rebuild the run timeline.
//
// What this module deliberately does NOT do
// -----------------------------------------
// - It does not call any provider API itself. Per the spec / task
//   guidance, the cert tests reuse the existing `VercelDeployAdapter`,
//   `FlyDeployAdapter`, `RenderDeployAdapter` classes. The harness
//   wraps the call sites only.
// - It does not implement its own backoff math beyond the exp-backoff
//   table. Adapters already have their own per-call retry inside
//   `_http.ts#fetchWithRetry`; the harness retries at the *check*
//   level (a whole assertion that hit a transient issue).
// - It does not own log redaction. Adapters always run `output` and
//   `streamLogs` lines through `redactLogLines()` from
//   `src/core/logging/redaction.ts` — the harness asserts the
//   redaction worked but does not reimplement it.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { GuardrailError } from '../../../src/core/errors.ts';

// ---------------------------------------------------------------------------
// Provider gating
// ---------------------------------------------------------------------------

export type ProviderId = 'vercel' | 'fly' | 'render';

/**
 * Per-provider env-var names. The cert suite intentionally uses
 * `*_TEST` suffixes so a developer's normal `VERCEL_TOKEN` /
 * `FLY_API_TOKEN` / `RENDER_API_KEY` (used for production deploys)
 * cannot be accidentally consumed by the certification suite.
 *
 * Treating "test" credentials as a separate axis means the GitHub
 * Actions secrets are scoped to free-tier sandbox accounts only — if
 * a cert test trashes a project, only the sandbox is affected.
 */
export const PROVIDER_TOKEN_ENV: Record<ProviderId, string> = {
  vercel: 'VERCEL_TOKEN_TEST',
  fly: 'FLY_API_TOKEN_TEST',
  render: 'RENDER_API_KEY_TEST',
};

/**
 * Optional per-provider sandbox-target env vars. The cert suite needs
 * to know *which* hello-world project / app / service to deploy
 * against — these IDs are pre-created on the free-tier accounts and
 * pinned via secrets so the suite is reproducible.
 *
 * Populated only when the operator sets them; the cert tests fall back
 * to "skip with friendly hint" if the token is present but the target
 * id is missing.
 */
export const PROVIDER_TARGET_ENV: Record<ProviderId, string> = {
  vercel: 'VERCEL_PROJECT_TEST',
  fly: 'FLY_APP_TEST',
  render: 'RENDER_SERVICE_TEST',
};

export interface ProviderEnv {
  /** True when the token AND the target-id env var are both set. */
  ready: boolean;
  /** True when the token alone is set (target id may still be missing). */
  hasToken: boolean;
  /** True when the target-id env var is set. */
  hasTarget: boolean;
  /** Resolved token value, or undefined when missing. */
  token: string | undefined;
  /** Resolved target-id value, or undefined when missing. */
  target: string | undefined;
  /**
   * Human-readable reason explaining why the suite is being skipped /
   * proceeding. Surfaced in `t.skip()` messages and in the NDJSON
   * `check.skipped` event.
   */
  reason: string;
}

/**
 * Resolve the env state for a provider. Pure function over an env
 * object — tests inject a synthetic env so they don't leak the real
 * process env into assertions.
 */
export function resolveProviderEnv(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ProviderEnv {
  const tokenName = PROVIDER_TOKEN_ENV[provider];
  const targetName = PROVIDER_TARGET_ENV[provider];
  const token = env[tokenName];
  const target = env[targetName];
  const hasToken = typeof token === 'string' && token.length > 0;
  const hasTarget = typeof target === 'string' && target.length > 0;
  let reason: string;
  if (!hasToken && !hasTarget) {
    reason = `${tokenName} and ${targetName} not set — cert suite skipped (this is the expected dev-machine path; see docs/adapters/cert-suite.md to enable)`;
  } else if (!hasToken) {
    reason = `${tokenName} not set — cert suite skipped (target ${targetName} is set but token is missing)`;
  } else if (!hasTarget) {
    reason = `${targetName} not set — cert suite skipped (token is present but no sandbox target id was provided; see docs/adapters/cert-suite.md)`;
  } else {
    reason = `${tokenName} + ${targetName} present — running live cert against sandbox`;
  }
  return {
    ready: hasToken && hasTarget,
    hasToken,
    hasTarget,
    token: hasToken ? token : undefined,
    target: hasTarget ? target : undefined,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Retry budget + flake control
// ---------------------------------------------------------------------------

/**
 * Per-spec exponential backoff schedule for transient retries:
 * 1s → 4s → 16s. The harness scales each interval through an
 * injectable sleep so the unit tests don't actually wait 21 seconds.
 */
export const RETRY_BACKOFF_MS: readonly number[] = Object.freeze([1000, 4000, 16000]);

/**
 * Maximum attempts — `RETRY_BACKOFF_MS.length + 1`. The schedule
 * `[1000, 4000, 16000]` defines the WAITS that happen *between* attempts,
 * so N waits implies N+1 attempts. With 4 attempts and 3 inter-attempt
 * gaps, every entry in `RETRY_BACKOFF_MS` is exercised. (Bugbot MEDIUM
 * PR #92: a prior `MAX_ATTEMPTS = RETRY_BACKOFF_MS.length` setting made
 * `RETRY_BACKOFF_MS[2]` (16s) provably unreachable, contradicting the
 * spec's "1s / 4s / 16s" schedule.) Total worst-case wall time per
 * provider+check: 1s + 4s + 16s = 21s of sleep + 4 × per-attempt cost.
 */
export const MAX_ATTEMPTS: number = RETRY_BACKOFF_MS.length + 1;

/**
 * After this many *consecutive* soft-fails on the same `(provider, check)`
 * tuple, the next soft-fail is auto-promoted to a hard-fail. Per spec.
 */
export const SOFT_FAIL_ESCALATION_THRESHOLD = 3;

/**
 * Categories the harness uses to classify a thrown error.
 *
 * - `transient` — eligible for retry (5xx, rate-limit, network drop).
 * - `deterministic` — never retried (auth, 404, schema mismatch).
 * - `flaky` — soft-failable (rollout race, log-streaming gap, eventual
 *   consistency window). Retried within the budget; escalated to a
 *   hard-fail after `SOFT_FAIL_ESCALATION_THRESHOLD` consecutive
 *   recurrences.
 * - `unknown` — no classification matched. Treated as `deterministic`
 *   so the failure surfaces immediately rather than burning the
 *   retry budget on an error nobody knows how to interpret.
 */
export type FailureCategory = 'transient' | 'deterministic' | 'flaky' | 'unknown';

/**
 * Map an exception (a `GuardrailError` from one of the adapters, or a
 * raw `Error`) onto a `FailureCategory`. The harness centralizes this
 * so each cert test doesn't reimplement classification.
 *
 * Mapping rules (kept narrow on purpose):
 * - `code === 'auth' | 'not_found' | 'invalid_config'` → deterministic.
 *   These are caller-fixable and will not self-heal between retries.
 * - `code === 'rate_limit' | 'transient_network'` → transient.
 * - Anything labelled by the test itself via `markFlaky()` (i.e.
 *   thrown as a `Error` whose `name === 'CertFlakeError'`) → flaky.
 * - Anything else → unknown.
 */
export function classifyError(err: unknown): FailureCategory {
  if (err instanceof GuardrailError) {
    if (err.code === 'auth' || err.code === 'not_found' || err.code === 'invalid_config') {
      return 'deterministic';
    }
    if (err.code === 'rate_limit' || err.code === 'transient_network') {
      return 'transient';
    }
    return 'unknown';
  }
  if (err instanceof Error && err.name === 'CertFlakeError') return 'flaky';
  return 'unknown';
}

/**
 * Synthetic error class the cert tests throw when an assertion failed
 * for a reason the harness should treat as "flaky" — typically log
 * lines arriving outside a polling window, or a deploy URL not yet
 * propagating through DNS. Used in lieu of overloading the
 * `GuardrailError` taxonomy.
 */
export class CertFlakeError extends Error {
  override readonly name = 'CertFlakeError';
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Soft-fail counter (per provider+check tuple)
// ---------------------------------------------------------------------------

/**
 * In-memory counter that survives across check invocations within a
 * single `node --test` process so the escalation threshold has any
 * meaning. (CI runs are nightly + isolated so cross-process state
 * would defeat the alerting purpose; the spec calls for "after three
 * *consecutive* soft-fails" which is per-run.)
 *
 * Exported as a class rather than a module-level singleton so unit
 * tests can spin up a fresh counter without leaking state between
 * cases.
 */
export class SoftFailCounter {
  private readonly counts = new Map<string, number>();

  private key(provider: ProviderId, check: string): string {
    return `${provider}::${check}`;
  }

  /** Returns the number of consecutive soft-fails for this tuple. */
  get(provider: ProviderId, check: string): number {
    return this.counts.get(this.key(provider, check)) ?? 0;
  }

  /** Increment the counter and return the new value. */
  recordSoftFail(provider: ProviderId, check: string): number {
    const k = this.key(provider, check);
    const next = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, next);
    return next;
  }

  /** Clear the counter (called on success). */
  recordSuccess(provider: ProviderId, check: string): void {
    this.counts.delete(this.key(provider, check));
  }

  /** Test-only helper to wipe all counters. */
  reset(): void {
    this.counts.clear();
  }
}

/**
 * Module-level singleton used by the cert tests. The unit tests
 * construct their own `SoftFailCounter` instances rather than
 * touching this one, so the escalation logic can be tested in
 * isolation.
 */
export const sharedSoftFailCounter = new SoftFailCounter();

// ---------------------------------------------------------------------------
// Artifact paths
// ---------------------------------------------------------------------------

/**
 * Where the harness drops `events.ndjson` + `log-tail.txt` for the
 * GitHub Actions workflow to upload. Resolved from
 * `process.env.ADAPTER_CERT_ARTIFACT_DIR` if present; otherwise
 * `<repo>/artifacts/adapter-cert/`. The workflow YAML sets the env
 * var to a CI-friendly path; locally, the default is fine.
 */
export function resolveArtifactRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ADAPTER_CERT_ARTIFACT_DIR;
  if (override && override.length > 0) return override;
  return path.join(process.cwd(), 'artifacts', 'adapter-cert');
}

/**
 * Per-run artifact path generator. The `runId` is typically a
 * monotonic timestamp (`ISO_<provider>_<utcDate>`). Paths are
 * deterministic per run so the workflow's `actions/upload-artifact`
 * step can glob them without knowing the run id ahead of time.
 */
export interface ArtifactPaths {
  runDir: string;
  eventsPath: string;
  logTailPath: string;
}

export function artifactPaths(
  provider: ProviderId,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): ArtifactPaths {
  const root = resolveArtifactRoot(env);
  const runDir = path.join(root, provider, runId);
  return {
    runDir,
    eventsPath: path.join(runDir, 'events.ndjson'),
    logTailPath: path.join(runDir, 'log-tail.txt'),
  };
}

/**
 * Generate a deterministic, sortable run id for a cert run. ULID
 * would be preferred (consistent with the rest of v6) but the cert
 * suite is allowed to be simpler — a UTC timestamp + random suffix
 * is unambiguous within a workflow run.
 */
export function newCertRunId(provider: ProviderId, nowIso?: string): string {
  const ts = (nowIso ?? new Date().toISOString()).replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}__${provider}__${rand}`;
}

// ---------------------------------------------------------------------------
// Event sink
// ---------------------------------------------------------------------------

export type CertEvent =
  | { ts: string; event: 'check.start'; provider: ProviderId; check: string }
  | { ts: string; event: 'check.attempt'; provider: ProviderId; check: string; attempt: number }
  | { ts: string; event: 'check.success'; provider: ProviderId; check: string; attempts: number; durationMs: number }
  | {
      ts: string;
      event: 'check.soft-fail';
      provider: ProviderId;
      check: string;
      consecutive: number;
      message: string;
    }
  | {
      ts: string;
      event: 'check.hard-fail';
      provider: ProviderId;
      check: string;
      category: FailureCategory;
      message: string;
    }
  | { ts: string; event: 'check.skipped'; provider: ProviderId; check: string; reason: string };

/**
 * Append-only NDJSON sink. Mirrors the shape of the v6 run-state
 * `events.ndjson` writer — same one-line-per-event invariant, same
 * `O_APPEND` durability story (each `appendFileSync` call invokes
 * the libuv append path which the kernel orders correctly under
 * single-writer use).
 */
export class CertEventSink {
  constructor(private readonly filePath: string) {}

  /** Ensure the parent directory exists. Idempotent. */
  ensureDir(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  /** Write one event line. */
  write(event: CertEvent): void {
    this.ensureDir();
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
  }

  /** Read every event back (test-only convenience). */
  readAll(): CertEvent[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs
      .readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as CertEvent);
  }
}

/**
 * Persist the last `maxLines` lines of provider log output to the
 * artifact dir. Per spec: "All cert runs persist events.ndjson +
 * last 200 log lines as workflow artifacts." This is invoked from
 * each cert test's `streamLogs` assertion (the only check that
 * accumulates raw log lines).
 */
export function writeLogTail(filePath: string, lines: readonly string[], maxLines = 200): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tail = lines.slice(-maxLines).join('\n');
  fs.writeFileSync(filePath, tail);
}

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

export interface RunCheckOptions {
  provider: ProviderId;
  check: string;
  /** Where to log events. Optional in tests. */
  sink?: CertEventSink;
  /** Soft-fail counter (lets unit tests inject a fresh one). */
  counter?: SoftFailCounter;
  /** Sleep impl — tests pass a no-op. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Override `Date.now()` so events are deterministic in tests. */
  nowImpl?: () => number;
  /** Random source for backoff jitter. Tests pass a deterministic stub
   *  (e.g. `() => 0` or `() => 0.5`) so the unit suite stays
   *  deterministic. Production uses `Math.random`. Per codex pre-flight
   *  WARNING #3: deterministic backoff `[1s, 4s, 16s]` aligns retry
   *  bursts across nightly runs into a recognizable automation
   *  fingerprint; 0-20% jitter smooths provider-side patterns. */
  randomImpl?: () => number;
}

export interface RunCheckResult {
  outcome: 'success' | 'soft-fail' | 'hard-fail';
  attempts: number;
  durationMs: number;
  /** When the outcome is a fail, the last category we classified. */
  category?: FailureCategory;
  /** When the outcome is a fail, the human-readable error message. */
  message?: string;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a single check with the harness's full retry + soft-fail
 * machinery wrapped around it.
 *
 * Returns a `RunCheckResult` rather than throwing — the cert test
 * decides whether a `soft-fail` should warn-and-continue or break
 * the suite. The default in the cert files is to `assert.ok` on
 * `outcome !== 'hard-fail'`, which lets soft-fails pass while
 * surfacing the warning in the NDJSON event stream.
 */
export async function runCheck(
  fn: () => Promise<void>,
  opts: RunCheckOptions,
): Promise<RunCheckResult> {
  const sink = opts.sink;
  const counter = opts.counter ?? sharedSoftFailCounter;
  const sleep = opts.sleepImpl ?? DEFAULT_SLEEP;
  const now = opts.nowImpl ?? Date.now;
  const random = opts.randomImpl ?? Math.random;
  const start = now();

  sink?.write({
    ts: new Date(now()).toISOString(),
    event: 'check.start',
    provider: opts.provider,
    check: opts.check,
  });

  let lastErr: unknown;
  let lastCategory: FailureCategory = 'unknown';
  // `attempt` is hoisted out of the for-clause so the post-loop hard-fail
  // branch can read the actual final attempt number. Bugbot LOW PR #92:
  // a prior `for (let attempt = ...)` made the variable inaccessible
  // post-loop and the hard-fail return path hardcoded `attempts: 1`,
  // which lied when the function had retried on transient errors before
  // finally throwing a deterministic error.
  let attempt = 0;
  for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    sink?.write({
      ts: new Date(now()).toISOString(),
      event: 'check.attempt',
      provider: opts.provider,
      check: opts.check,
      attempt,
    });
    try {
      await fn();
      counter.recordSuccess(opts.provider, opts.check);
      const result: RunCheckResult = {
        outcome: 'success',
        attempts: attempt,
        durationMs: now() - start,
      };
      sink?.write({
        ts: new Date(now()).toISOString(),
        event: 'check.success',
        provider: opts.provider,
        check: opts.check,
        attempts: attempt,
        durationMs: result.durationMs,
      });
      return result;
    } catch (err) {
      lastErr = err;
      lastCategory = classifyError(err);
      // Deterministic / unknown errors never retry — fail fast.
      if (lastCategory === 'deterministic' || lastCategory === 'unknown') {
        break;
      }
      // Transient + flaky retry within the budget. Adds 0-20% jitter
      // to the deterministic backoff so synchronized retry bursts
      // across nightly runs don't fingerprint our traffic on provider
      // anti-abuse systems (per codex pre-flight WARNING #3).
      if (attempt < MAX_ATTEMPTS) {
        const baseMs = RETRY_BACKOFF_MS[attempt - 1] ?? 0;
        const jitterMs = Math.floor(baseMs * 0.2 * random());
        await sleep(baseMs + jitterMs);
        continue;
      }
    }
  }

  // We exhausted the retry budget OR fell out via deterministic
  // category. Decide soft-fail vs hard-fail.
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const durationMs = now() - start;

  if (lastCategory === 'flaky' || lastCategory === 'transient') {
    const consecutive = counter.recordSoftFail(opts.provider, opts.check);
    if (consecutive >= SOFT_FAIL_ESCALATION_THRESHOLD) {
      // Escalate per spec: "After three consecutive soft-fails on the
      // same check, escalate to hard-fail."
      sink?.write({
        ts: new Date(now()).toISOString(),
        event: 'check.hard-fail',
        provider: opts.provider,
        check: opts.check,
        category: lastCategory,
        message: `escalated to hard-fail after ${consecutive} consecutive soft-fails: ${message}`,
      });
      return {
        outcome: 'hard-fail',
        attempts: MAX_ATTEMPTS,
        durationMs,
        category: lastCategory,
        message: `escalated to hard-fail after ${consecutive} consecutive soft-fails: ${message}`,
      };
    }
    sink?.write({
      ts: new Date(now()).toISOString(),
      event: 'check.soft-fail',
      provider: opts.provider,
      check: opts.check,
      consecutive,
      message,
    });
    return {
      outcome: 'soft-fail',
      attempts: MAX_ATTEMPTS,
      durationMs,
      category: lastCategory,
      message,
    };
  }

  // Deterministic or unknown — hard-fail immediately.
  sink?.write({
    ts: new Date(now()).toISOString(),
    event: 'check.hard-fail',
    provider: opts.provider,
    check: opts.check,
    category: lastCategory,
    message,
  });
  return {
    outcome: 'hard-fail',
    // Use the actual loop counter, not a hardcoded `1`. When a transient
    // error retries and a later attempt throws a deterministic error,
    // `attempt` reflects the real attempt number that produced the
    // hard-fail. (Bugbot LOW PR #92.)
    attempts: attempt,
    durationMs,
    category: lastCategory,
    message,
  };
}

// ---------------------------------------------------------------------------
// Workflow exit code
// ---------------------------------------------------------------------------

/**
 * Compute the workflow exit code from a list of `RunCheckResult`s.
 *
 * - Any `hard-fail` → exit 1 (workflow turns red).
 * - Otherwise → exit 0 (soft-fails are alerted but don't break CI).
 *
 * The cert tests use `node:test`'s native pass/fail wiring; this
 * helper exists so the GitHub Actions workflow can post-process
 * a JSON summary if we ever want to surface counts to a Slack-equivalent
 * channel. Today, the workflow only inspects the test runner's exit
 * code and uploads the artifacts — but the helper keeps the harness
 * future-friendly without painting us into a corner.
 */
export function workflowExitCode(results: readonly RunCheckResult[]): number {
  return results.some((r) => r.outcome === 'hard-fail') ? 1 : 0;
}
