// src/adapters/deploy/types.ts
//
// DeployAdapter contract — Phase 1 of the v5.4 Vercel adapter spec.
//
// A DeployAdapter abstracts over the "deploy this code somewhere" step of the
// pipeline. Adapters can be platform-specific (vercel, fly, render) or generic
// (a free-form shell command à la `vercel --prod` from v5.3).
//
// Phase 1 implements `deploy()` and `status()`. `rollback()` is reserved for
// Phase 3 and intentionally optional on the interface so generic adapters that
// don't support it can omit the method entirely.
//
// Spec: docs/specs/v5.4-vercel-adapter.md

/**
 * Common input to a deploy operation.
 *
 * Adapters are free to ignore fields they don't need. The Vercel adapter uses
 * `commitSha` (and the env-derived git source) to choose what to build; the
 * generic adapter uses neither — it just runs the configured deploy command.
 */
export interface DeployInput {
  /** Symbolic git ref (branch / tag). Optional — adapters fall back to the configured target. */
  ref?: string;
  /** Specific commit SHA to deploy. Takes precedence over `ref` when both are set. */
  commitSha?: string;
  /** Free-form metadata propagated to the platform when supported (Vercel attaches as deployment meta). */
  meta?: Record<string, string>;
  /** Abort signal — adapters MUST honor this for any in-flight HTTP / spawn work. */
  signal?: AbortSignal;
  /**
   * Fired exactly once with the platform-native deploy ID as soon as it's
   * known. Adapters that obtain the ID synchronously (Vercel returns it from
   * the create-deployment POST) MUST call this immediately after the POST
   * resolves but before polling begins. Adapters with no discrete ID (the
   * generic shell adapter) do NOT call it.
   *
   * Consumers use this to start side-channel work in parallel with the
   * deploy — most notably log streaming via `--watch`.
   */
  onDeployStart?: (deployId: string) => void;
}

/**
 * Outcome of a deploy operation.
 *
 * `status: 'in-progress'` is reserved for the case where polling timed out
 * before the platform reached a terminal state — the deploy may still finish
 * later. The adapter does NOT auto-resume in Phase 1; the caller can re-poll
 * via `status({ deployId })`.
 */
export interface DeployResult {
  status: 'pass' | 'fail' | 'in-progress';
  /** Adapter-native deploy ID. Vercel uses `dpl_xxx`. Empty for generic when stdout has no extractable URL. */
  deployId?: string;
  /** Public URL of the deploy (e.g. `https://my-app-abc.vercel.app`). */
  deployUrl?: string;
  /** URL to the build logs / dashboard for human follow-up. */
  buildLogsUrl?: string;
  /** Wall-clock duration of the adapter call, in milliseconds. */
  durationMs: number;
  /** Human-readable summary suitable for the PR comment (last 50 log lines, status line, etc.). */
  output?: string;
  /** Populated when the adapter auto-rolled back to a previous deploy. Phase 3+. */
  rolledBackTo?: string;
}

/**
 * Input to a one-shot status query (no polling). Used by the future
 * `claude-autopilot deploy status <id>` CLI subcommand and by the polling
 * loop inside `deploy()`.
 */
export interface DeployStatusInput {
  deployId: string;
  signal?: AbortSignal;
}

/**
 * Result of a one-shot status query. Same shape as DeployResult with the
 * deployId required for traceability. Adapters that don't support status
 * (e.g. generic) leave the `status` method unimplemented.
 */
export interface DeployStatusResult extends Omit<DeployResult, 'deployId'> {
  deployId: string;
}

/**
 * Input to a rollback operation. Reserved for Phase 3.
 *
 * `to` is optional: when omitted the adapter rolls back to the previous
 * production deploy (looked up via the platform API).
 */
export interface DeployRollbackInput {
  /** Specific deploy ID to roll back to. When omitted, the previous prod deploy is used. */
  to?: string;
  signal?: AbortSignal;
}

/**
 * Input to a one-shot log-streaming subscription.
 *
 * Returned `AsyncIterable` yields `DeployLogLine`s as the platform emits
 * them. Consumers iterate with `for await ... of`. Cancellation is via the
 * `signal` — once aborted, the underlying transport is torn down and the
 * iterator finishes (or throws `AbortError`, depending on adapter).
 */
export interface DeployStreamLogsInput {
  deployId: string;
  signal?: AbortSignal;
}

/**
 * A single log line surfaced from the platform.
 *
 * Fields beyond `timestamp` and `text` are best-effort — adapters populate
 * what they have. Consumers MUST NOT rely on `level` or `source` being set.
 */
export interface DeployLogLine {
  /** Milliseconds since epoch — from the platform if provided, else when received locally. */
  timestamp: number;
  /** Build phase or component (e.g. 'build', 'deploy'). Optional. */
  source?: string;
  /** 'info' | 'warn' | 'error' | 'stdout' | 'stderr' — adapter-defined. Optional. */
  level?: string;
  /** Log text, no trailing newline. */
  text: string;
}

/**
 * The DeployAdapter contract.
 *
 * `deploy` is required. `status` and `rollback` are optional so adapters that
 * don't expose them (the generic shell adapter being the canonical example)
 * can omit the methods rather than throwing at runtime.
 */
export interface DeployAdapter {
  /** Stable identifier — surfaced in CLI output and logs. */
  readonly name: string;
  deploy(input: DeployInput): Promise<DeployResult>;
  status?(input: DeployStatusInput): Promise<DeployStatusResult>;
  rollback?(input: DeployRollbackInput): Promise<DeployResult>;
  /**
   * Subscribe to real-time build logs. Optional — adapters without a
   * platform API for log streaming (e.g. the generic shell adapter) omit
   * this method, and the `undefined` is the canonical "not supported"
   * signal for callers.
   */
  streamLogs?(input: DeployStreamLogsInput): AsyncIterable<DeployLogLine>;
}

/**
 * Configuration block for the `deploy` phase. Lives under `deploy:` in
 * `guardrail.config.yaml`.
 *
 * Fields are conditionally required based on `adapter`:
 * - `vercel` requires `project`
 * - `generic` requires `deployCommand`
 *
 * The factory in `./index.ts` enforces these rules at construction time.
 */
export interface DeployConfig {
  /** Which adapter to use. Phase 1 ships `vercel` + `generic`. */
  adapter: 'vercel' | 'generic';

  // Vercel-specific
  /** Vercel project ID or slug. Required when `adapter === 'vercel'`. */
  project?: string;
  /** Vercel team ID for team accounts. Optional. */
  team?: string;
  /** Deploy target. Default: `production`. */
  target?: 'production' | 'preview';

  // Generic-specific
  /** Shell command to run for the deploy (e.g. `vercel --prod`). Required when `adapter === 'generic'`. */
  deployCommand?: string;

  // Cross-cutting (read by future phases — accepted today, no behavior)
  /** Stream build logs to stderr in real time. Phase 2. */
  watchBuildLogs?: boolean;
  /** Auto-rollback triggers. Phase 3 / 4. */
  rollbackOn?: Array<'healthCheckFailure' | 'smokeTestFailure'>;
  /** URL polled after deploy succeeds to confirm app health. Used by both adapters once Phase 4 lands. */
  healthCheckUrl?: string;
}
