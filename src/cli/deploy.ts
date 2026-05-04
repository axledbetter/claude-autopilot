// src/cli/deploy.ts
//
// `claude-autopilot deploy` — Phase 1 of the v5.4 Vercel adapter spec.
//
// Loads guardrail.config.yaml, picks a deploy adapter (config or `--adapter`
// override), runs the deploy, prints a one-line status, returns an exit code.
//
// Phase 1 wires only the deploy verb. `deploy status` and `deploy rollback`
// are scaffolded in the spec for Phase 5 (CLI subcommands wrapping
// adapter.status/rollback) and not implemented here.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GuardrailError } from '../core/errors.ts';
import { loadConfig } from '../core/config/loader.ts';
import { runSafe } from '../core/shell.ts';
import { createDeployAdapter } from '../adapters/deploy/index.ts';
import type { DeployAdapter, DeployConfig, DeployResult } from '../adapters/deploy/types.ts';
import type { VercelDeployListItem } from '../adapters/deploy/vercel.ts';

/**
 * Surface of an adapter that supports `deploy status` listing. The
 * `DeployAdapter` contract doesn't include `listDeployments` (it's a
 * Vercel-flavored capability that other adapters may not have), so we
 * type the CLI dependency narrowly via duck-typing.
 */
interface ListDeploymentsCapable {
  listDeployments(limit?: number): Promise<VercelDeployListItem[]>;
}

function hasListDeployments(a: DeployAdapter): a is DeployAdapter & ListDeploymentsCapable {
  return typeof (a as Partial<ListDeploymentsCapable>).listDeployments === 'function';
}

export interface RunDeployOptions {
  configPath?: string;
  /** When set, overrides `deploy.adapter` from config. */
  adapterOverride?: 'vercel' | 'fly' | 'render' | 'generic';
  ref?: string;
  commitSha?: string;
  cwd?: string;
  /** Phase 2 — when true, subscribe to streamLogs() and pipe to stderr. */
  watch?: boolean;
  /**
   * Test seam — allows injecting a fake DeployAdapter without going through
   * the real factory (which requires VERCEL_TOKEN etc.). Production callers
   * MUST NOT set this.
   */
  adapterFactory?: (config: DeployConfig) => DeployAdapter;
  /**
   * Test seam — injected `fetch` implementation for the post-deploy health
   * check. Defaults to `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test seam — injected sleep function used between health-check retries.
   * Defaults to `setTimeout`-based sleep. Pass `async () => {}` from tests.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /** GitHub PR number — when set, post upserting deploy summary comment. */
  pr?: number;
  /**
   * Test seam — injected `gh` CLI runner. Receives argv plus an optional
   * stdin `body` (passed via `gh ... --body-file -`). Returns stdout.
   * Defaults to `core/shell.runSafe`.
   */
  ghImpl?: (args: string[], opts?: { body?: string; cwd?: string }) => string;
}

/**
 * Returns process exit code.
 *  0 — deploy passed
 *  1 — deploy failed (build error, auth error, missing config)
 *  2 — still in progress at poll timeout (caller may retry via deploy status)
 */
/**
 * Shared config-loading + adapter-merge logic used by all `deploy` runners
 * (`runDeploy`, `runDeployRollback`, `runDeployStatus`). Returns either the
 * merged `DeployConfig` or an exit code that the caller should propagate.
 *
 * Error-vs-success split mirrors the original inline behavior in `runDeploy`:
 * explicit `--config <missing>` is loud; default-path missing is silent and
 * falls through to the "no adapter configured" check (Bugbot HIGH on PR #59).
 */
async function loadDeployConfigAsync(opts: {
  cwd?: string;
  configPath?: string;
  adapterOverride?: 'vercel' | 'fly' | 'render' | 'generic';
}): Promise<{ merged: DeployConfig } | { errorCode: number }> {
  const cwd = opts.cwd ?? process.cwd();
  const explicitConfig = opts.configPath !== undefined;
  const configPath = opts.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let configBlock: DeployConfig | undefined;
  if (fs.existsSync(configPath)) {
    try {
      const config = await loadConfig(configPath);
      configBlock = config.deploy;
    } catch (err) {
      console.error(formatErr('failed to load config', err));
      return { errorCode: 1 };
    }
  } else if (explicitConfig) {
    console.error(`\x1b[31m[deploy] config file not found: ${configPath}\x1b[0m`);
    return { errorCode: 1 };
  }

  const adapter = opts.adapterOverride ?? configBlock?.adapter;
  if (!adapter) {
    console.error(
      '\x1b[31m[deploy] no deploy adapter configured\x1b[0m\n' +
        '  hint: set `deploy.adapter` in guardrail.config.yaml, or pass --adapter <vercel|fly|render|generic>',
    );
    return { errorCode: 1 };
  }

  const merged: DeployConfig = {
    ...(configBlock ?? { adapter }),
    adapter,
  };
  return { merged };
}

export async function runDeploy(opts: RunDeployOptions): Promise<number> {
  const loaded = await loadDeployConfigAsync(opts);
  if ('errorCode' in loaded) return loaded.errorCode;
  const { merged } = loaded;
  const adapter = merged.adapter;

  let result: DeployResult;
  let healthOutcome: HealthCheckOutcome = { status: 'skipped' };
  let streamController: AbortController | undefined;
  let streamPromise: Promise<void> | undefined;
  let deployAdapterRef: DeployAdapter | undefined;
  try {
    const factory = opts.adapterFactory ?? createDeployAdapter;
    const deployAdapter = factory(merged);
    deployAdapterRef = deployAdapter;

    // --watch: opt into log streaming. We start the stream from inside an
    // onDeployStart callback so it begins as soon as the platform returns
    // an ID, in parallel with the (still-running) deploy.
    let onDeployStart: ((deployId: string) => void) | undefined;
    if (opts.watch) {
      if (typeof deployAdapter.streamLogs === 'function') {
        // Phase 3 of v5.6 — when an adapter advertises `streamMode: 'polling'`
        // (currently only Render), surface a one-line stderr notice BEFORE
        // iteration starts so users understand why their log lines arrive
        // in batches with short gaps. Adapters with `streamMode: 'websocket'`
        // (Vercel SSE, Fly WS) or `'none'`/undefined get no notice — their
        // streaming behavior matches user expectations. Spec: § "Capability
        // metadata".
        if (deployAdapter.capabilities?.streamMode === 'polling') {
          process.stderr.write(
            `[deploy] note: ${deployAdapter.name} uses 2s log polling — lines may arrive in batches and could include short gaps. See docs/deploy/adapters.md#log-streaming for details.\n`,
          );
        }
        streamController = new AbortController();
        const streamFn = deployAdapter.streamLogs.bind(deployAdapter);
        const ctrlSignal = streamController.signal;
        const adapterName = deployAdapter.name;
        onDeployStart = (deployId: string) => {
          streamPromise = (async () => {
            try {
              for await (const line of streamFn({ deployId, signal: ctrlSignal })) {
                process.stderr.write(`[deploy:${adapterName}] ${line.text}\n`);
              }
            } catch (err) {
              if (!(err instanceof Error && err.name === 'AbortError')) {
                console.error(`\x1b[2m[deploy] log stream ended: ${(err as Error)?.message ?? String(err)}\x1b[0m`);
              }
            }
          })();
        };
      } else {
        console.error(
          `\x1b[33m[deploy] --watch ignored — adapter "${deployAdapter.name}" does not support log streaming\x1b[0m`,
        );
      }
    }

    result = await deployAdapter.deploy({
      ref: opts.ref,
      commitSha: opts.commitSha,
      onDeployStart,
    });

    // Stop the stream now that the deploy is settled. Wait briefly so any
    // in-flight log lines flush before we report.
    streamController?.abort();
    if (streamPromise) {
      try { await streamPromise; } catch { /* already logged */ }
    }

    // Phase 4 — post-deploy health check. Skipped when deploy itself failed
    // OR when no explicit `healthCheckUrl` is configured. We deliberately do
    // NOT fall back to `result.deployUrl`: silently probing the deploy URL
    // would change behavior for everyone upgrading to Phase 4 (their deploys
    // would suddenly fail if the URL is preview-only or rate-limited). Health
    // checks are opt-in via config. The spec explicitly leaves room for a
    // future `healthCheckUrl: auto` mode that interpolates from `deployUrl`.
    if (result.status === 'pass') {
      const healthUrl = merged.healthCheckUrl;
      if (healthUrl) {
        healthOutcome = await runHealthCheck({
          url: healthUrl,
          fetchImpl: opts.fetchImpl ?? globalThis.fetch,
          sleepImpl: opts.sleepImpl ?? defaultSleep,
        });
        if (healthOutcome.status === 'fail') {
          const triggers = merged.rollbackOn ?? [];
          const wantRollback = triggers.includes('healthCheckFailure');
          if (wantRollback) {
            if (typeof deployAdapter.rollback === 'function') {
              // BOUND: exactly one auto-rollback per deploy attempt (spec §
              // "Health-check policy" → "After rollback completes (success
              // or failure), the adapter returns; no second rollback
              // attempt"). The single `rollback({})` call below is the only
              // place this path is invoked; we do NOT loop. Result status
              // becomes one of the two new terminal values:
              //   - `fail_rolled_back` — rollback returned `pass`
              //   - `fail_rollback_failed` — rollback returned non-pass OR threw
              try {
                const rb = await deployAdapter.rollback({});
                if (rb.status === 'pass') {
                  result = {
                    ...result,
                    status: 'fail_rolled_back',
                    rolledBackTo: rb.rolledBackTo ?? rb.deployId,
                    output: `Deploy passed; health check failed (${healthOutcome.lastError}); auto-rolled back to ${rb.rolledBackTo ?? rb.deployId ?? '<unknown>'}.`,
                  };
                  printAutoRollback(deployAdapter.name, healthOutcome, rb);
                } else {
                  result = {
                    ...result,
                    status: 'fail_rollback_failed',
                    output: `Deploy passed; health check failed; auto-rollback ALSO failed: ${rb.output ?? '<no output>'}`,
                  };
                  printAutoRollbackFailed(rb.output ?? 'rollback returned non-pass');
                }
              } catch (err) {
                const msg = (err as Error)?.message ?? String(err);
                result = {
                  ...result,
                  status: 'fail_rollback_failed',
                  output: `Deploy passed; health check failed; auto-rollback ERRORED: ${msg}`,
                };
                printAutoRollbackFailed(msg);
              }
            } else {
              console.error(
                `\x1b[33m[deploy] rollbackOn=[healthCheckFailure] configured but adapter "${deployAdapter.name}" does not support rollback\x1b[0m`,
              );
              result = {
                ...result,
                status: 'fail',
                output: `Deploy passed but health check failed: ${healthOutcome.lastError} at ${healthOutcome.url} (adapter does not support rollback)`,
              };
            }
          } else {
            result = {
              ...result,
              status: 'fail',
              output: `Deploy passed but health check failed: ${healthOutcome.lastError} at ${healthOutcome.url}`,
            };
          }
        }
      }
    }
  } catch (err) {
    streamController?.abort();
    if (streamPromise) {
      try { await streamPromise; } catch { /* already logged */ }
    }
    console.error(formatErr(`deploy via ${adapter} failed`, err));
    return 1;
  }

  printResult(adapter, result);

  if (opts.pr !== undefined) {
    try {
      postDeployPrComment({
        pr: opts.pr,
        cwd: opts.cwd ?? process.cwd(),
        adapterName: deployAdapterRef?.name ?? adapter,
        result,
        healthOutcome,
        ghImpl: opts.ghImpl ?? defaultGhImpl,
      });
    } catch (err) {
      console.error(
        `\x1b[33m[deploy] failed to post PR comment: ${(err as Error)?.message ?? String(err)}\x1b[0m`,
      );
    }
  }

  if (result.status === 'pass') return 0;
  if (result.status === 'in-progress') return 2;
  return 1;
}

function printResult(adapter: string, r: DeployResult): void {
  const color =
    r.status === 'pass' ? '\x1b[32m' : r.status === 'in-progress' ? '\x1b[33m' : '\x1b[31m';
  const seconds = (r.durationMs / 1000).toFixed(1);
  const parts = [`status=${r.status}`, `adapter=${adapter}`];
  if (r.deployId) parts.push(`deployId=${r.deployId}`);
  if (r.deployUrl) parts.push(`url=${r.deployUrl}`);
  parts.push(`duration=${seconds}s`);
  console.log(`${color}[deploy] ${parts.join(' ')}\x1b[0m`);
  if (r.buildLogsUrl) console.log(`\x1b[2m  logs: ${r.buildLogsUrl}\x1b[0m`);
  if (r.output && r.status !== 'pass') {
    console.log(`\x1b[2m${r.output}\x1b[0m`);
  }
}

function formatErr(prefix: string, err: unknown): string {
  if (err instanceof GuardrailError) {
    const provider = err.provider ? ` [${err.provider}]` : '';
    const code = `[${err.code}]`;
    const hint = err.code === 'auth' ? '\n  hint: check VERCEL_TOKEN at https://vercel.com/account/tokens' : '';
    return `\x1b[31m[deploy] ${prefix}${provider} ${code} ${err.message}\x1b[0m${hint}`;
  }
  return `\x1b[31m[deploy] ${prefix}: ${(err as Error)?.message ?? String(err)}\x1b[0m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — `deploy rollback` and `deploy status` subcommands.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunDeployRollbackOptions {
  configPath?: string;
  adapterOverride?: 'vercel' | 'fly' | 'render' | 'generic';
  /** Specific deploy ID to roll back to. When omitted, the previous prod deploy is used. */
  to?: string;
  cwd?: string;
  /** Test seam — same contract as `RunDeployOptions.adapterFactory`. */
  adapterFactory?: (config: DeployConfig) => DeployAdapter;
}

export interface RunDeployStatusOptions {
  configPath?: string;
  adapterOverride?: 'vercel' | 'fly' | 'render' | 'generic';
  cwd?: string;
  adapterFactory?: (config: DeployConfig) => DeployAdapter;
}

/**
 * Handle `claude-autopilot deploy rollback [--to <id>]`.
 *
 * Returns process exit code (0 on success, 1 on failure). Failure modes:
 * - Adapter doesn't implement rollback (e.g. generic adapter).
 * - No previous prod deploy exists when `--to` is omitted.
 * - Auth / network / API error (surfaced via formatErr).
 */
export async function runDeployRollback(opts: RunDeployRollbackOptions): Promise<number> {
  const loaded = await loadDeployConfigAsync(opts);
  if ('errorCode' in loaded) return loaded.errorCode;
  const { merged } = loaded;
  const adapter = merged.adapter;

  let result: DeployResult;
  try {
    const factory = opts.adapterFactory ?? createDeployAdapter;
    const deployAdapter = factory(merged);
    if (typeof deployAdapter.rollback !== 'function') {
      console.error(
        `\x1b[31m[deploy] adapter "${deployAdapter.name}" does not support rollback\x1b[0m`,
      );
      return 1;
    }
    result = await deployAdapter.rollback({ to: opts.to });
  } catch (err) {
    console.error(formatErr(`rollback via ${adapter} failed`, err));
    return 1;
  }

  printRollbackResult(adapter, result);
  return result.status === 'pass' ? 0 : 1;
}

function printRollbackResult(adapter: string, r: DeployResult): void {
  const color = r.status === 'pass' ? '\x1b[32m' : '\x1b[31m';
  const seconds = (r.durationMs / 1000).toFixed(1);
  const parts = [`status=${r.status}`, `adapter=${adapter}`];
  if (r.rolledBackTo) parts.push(`rolledBackTo=${r.rolledBackTo}`);
  if (r.deployUrl) parts.push(`url=${r.deployUrl}`);
  parts.push(`duration=${seconds}s`);
  console.log(`${color}[deploy] rollback ${parts.join(' ')}\x1b[0m`);
  if (r.buildLogsUrl) console.log(`\x1b[2m  logs: ${r.buildLogsUrl}\x1b[0m`);
  if (r.output && r.status !== 'pass') {
    console.log(`\x1b[2m${r.output}\x1b[0m`);
  }
}

/**
 * Handle `claude-autopilot deploy status`. Lists the current production
 * deploy plus the last 5 builds (newest-first), pulling from the adapter's
 * `listDeployments` capability. Adapters that don't expose this method
 * (e.g. the generic shell adapter) get a clear error and exit 1.
 */
export async function runDeployStatus(opts: RunDeployStatusOptions): Promise<number> {
  const loaded = await loadDeployConfigAsync(opts);
  if ('errorCode' in loaded) return loaded.errorCode;
  const { merged } = loaded;
  const adapter = merged.adapter;

  try {
    const factory = opts.adapterFactory ?? createDeployAdapter;
    const deployAdapter = factory(merged);
    if (!hasListDeployments(deployAdapter)) {
      console.error(
        `\x1b[31m[deploy] adapter "${deployAdapter.name}" does not support status listing\x1b[0m`,
      );
      return 1;
    }
    const items = await deployAdapter.listDeployments(5);
    const sorted = [...items].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    printStatus(adapter, sorted);
    return 0;
  } catch (err) {
    console.error(formatErr(`status via ${adapter} failed`, err));
    return 1;
  }
}

function printStatus(adapter: string, items: VercelDeployListItem[]): void {
  console.log(`\x1b[1m[deploy] status — adapter=${adapter}\x1b[0m`);
  if (items.length === 0) {
    console.log('\x1b[2m  (no deployments found)\x1b[0m');
    return;
  }
  const current = items[0]!;
  const rest = items.slice(1);
  console.log(
    `  current: ${current.id}` +
      (current.state ? ` state=${current.state}` : '') +
      (current.url ? ` url=https://${current.url}` : '') +
      (typeof current.createdAt === 'number' ? ` age=${formatAge(current.createdAt)}` : ''),
  );
  if (rest.length > 0) {
    console.log('  recent builds:');
    for (const d of rest) {
      console.log(
        `    ${d.id}` +
          (d.state ? ` state=${d.state}` : '') +
          (typeof d.createdAt === 'number' ? ` age=${formatAge(d.createdAt)}` : '') +
          (d.url ? ` url=https://${d.url}` : ''),
      );
    }
  }
}

function formatAge(createdAtMs: number): string {
  const deltaMs = Date.now() - createdAtMs;
  if (deltaMs < 0) return '0s';
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — post-deploy health check + auto-rollback orchestration.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Outcome of the post-deploy health check.
 * - `pass`: at least one attempt returned 2xx within the retry budget.
 * - `fail`: all attempts failed (non-2xx, network error, or per-attempt timeout).
 * - `skipped`: no `healthCheckUrl` resolvable (no config + no deployUrl).
 */
type HealthCheckOutcome =
  | { status: 'pass'; url: string }
  | { status: 'fail'; url: string; lastError: string }
  | { status: 'skipped' };

interface HealthCheckOptions {
  url: string;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
}

/** Per v5.6 spec § "Health-check policy" — cap retries at 5× with 6s backoff. */
const HEALTH_CHECK_MAX_ATTEMPTS = 5;
const HEALTH_CHECK_BACKOFF_MS = 6000;

/**
 * Probe a URL up to {@link HEALTH_CHECK_MAX_ATTEMPTS} times with
 * {@link HEALTH_CHECK_BACKOFF_MS} backoff between attempts. 2xx → pass.
 * Per-attempt timeout is 10s. Network errors are treated as failures and
 * retried.
 *
 * Total wall-clock budget: ~30s (5 attempts × 6s backoff between, minus
 * the trailing skip — matches the spec's "max ~30s window").
 */
async function runHealthCheck(opts: HealthCheckOptions): Promise<HealthCheckOutcome> {
  const { url, fetchImpl, sleepImpl } = opts;
  let lastError = '';
  for (let attempt = 1; attempt <= HEALTH_CHECK_MAX_ATTEMPTS; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status >= 200 && res.status < 300) {
        return { status: 'pass', url };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      clearTimeout(timer);
      lastError = (err as Error)?.message ?? String(err);
    }
    if (attempt < HEALTH_CHECK_MAX_ATTEMPTS) await sleepImpl(HEALTH_CHECK_BACKOFF_MS);
  }
  return { status: 'fail', url, lastError };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Print the distinct yellow auto-rollback marker. Called only after the
 * adapter's `rollback({})` returned `pass` — i.e. the previous prod deploy
 * has been promoted and is now serving traffic.
 */
function printAutoRollback(
  adapter: string,
  hc: Extract<HealthCheckOutcome, { status: 'fail' }>,
  rb: DeployResult,
): void {
  const yellow = '\x1b[33m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const target = rb.rolledBackTo ?? rb.deployId ?? '<unknown>';
  console.log(
    `${yellow}🔄 [deploy] auto-rolled-back-to=${target} via=${adapter} health-check-url=${hc.url}${reset}`,
  );
  console.log(
    `${dim}   reason: health check failed ${HEALTH_CHECK_MAX_ATTEMPTS}x against ${hc.url} (${hc.lastError})${reset}`,
  );
  if (rb.deployUrl) {
    console.log(`${dim}   current: ${rb.deployUrl}${reset}`);
  }
}

/**
 * Print the auto-rollback failure marker. Called when the rollback attempt
 * itself errors or returns non-pass — the original (failing) deploy is
 * still in place and the operator must intervene.
 */
function printAutoRollbackFailed(reason: string): void {
  const yellow = '\x1b[33m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  console.log(`${yellow}🔄 [deploy] auto-rollback FAILED — original deploy left in place${reset}`);
  console.log(`${dim}   reason: ${reason}${reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — `--pr <n>` deploy summary comment.
// ─────────────────────────────────────────────────────────────────────────────

const DEPLOY_COMMENT_MARKER = '<!-- claude-autopilot-deploy -->';

interface DeployCommentInput {
  pr: number;
  cwd: string;
  adapterName: string;
  result: DeployResult;
  healthOutcome: HealthCheckOutcome;
  ghImpl: (args: string[], opts?: { body?: string; cwd?: string }) => string;
}

/** Build the markdown body for the deploy summary comment. Pure, side-effect-free. */
function buildDeployCommentBody(input: Omit<DeployCommentInput, 'ghImpl' | 'cwd' | 'pr'>): string {
  const { adapterName, result, healthOutcome } = input;
  const lines: string[] = [DEPLOY_COMMENT_MARKER];
  if (result.rolledBackTo) {
    lines.push('## ❌ Deploy auto-rolled back', '');
    lines.push('| Step | Status | URL / ID |');
    lines.push('|---|:---:|---|');
    lines.push(
      `| New deploy \`${result.deployId ?? 'unknown'}\` | ✅ built | ${result.deployUrl ?? '—'} |`,
    );
    if (healthOutcome.status === 'fail') {
      lines.push(`| Health check | ❌ failed | ${healthOutcome.url} |`);
    }
    lines.push(
      `| Auto-rollback to \`${result.rolledBackTo}\` | ✅ promoted | (current production) |`,
    );
  } else if (result.status === 'pass') {
    lines.push('## ✅ Deploy succeeded', '');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push(`| Deploy ID | \`${result.deployId ?? 'unknown'}\` |`);
    if (result.deployUrl) lines.push(`| URL | ${result.deployUrl} |`);
    if (healthOutcome.status === 'pass') {
      lines.push(`| Health check | ✅ ${healthOutcome.url} |`);
    }
  } else {
    lines.push('## ❌ Deploy failed', '');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    if (result.deployId) lines.push(`| Deploy ID | \`${result.deployId}\` |`);
    if (result.deployUrl) lines.push(`| URL | ${result.deployUrl} |`);
    if (result.output) lines.push(`| Reason | ${result.output.replace(/\n/g, ' ')} |`);
  }
  lines.push('', `*adapter=${adapterName} · duration=${(result.durationMs / 1000).toFixed(1)}s*`);
  return lines.join('\n');
}

/**
 * Upsert the deploy summary comment on a PR. Looks up an existing comment
 * anchored on `DEPLOY_COMMENT_MARKER` and PATCHes it; otherwise creates
 * a new one. The marker is distinct from `<!-- guardrail-review -->` so
 * deploy and review comments coexist.
 */
function postDeployPrComment(input: DeployCommentInput): void {
  const { pr, cwd, ghImpl } = input;
  const body = buildDeployCommentBody(input);
  const lookup = ghImpl(
    [
      'api',
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      '--jq',
      `[.[] | select(.body | startswith("${DEPLOY_COMMENT_MARKER}")) | .id] | first`,
    ],
    { cwd },
  );
  const existingId = lookup.trim();
  if (existingId && /^\d+$/.test(existingId)) {
    ghImpl(
      [
        'api',
        `repos/{owner}/{repo}/issues/comments/${existingId}`,
        '--method',
        'PATCH',
        '--field',
        'body=@-',
      ],
      { cwd, body },
    );
  } else {
    ghImpl(['pr', 'comment', String(pr), '--body-file', '-'], { cwd, body });
  }
}

/**
 * Default `gh` runner — wraps `core/shell.runSafe` and passes `body` (when
 * present) via stdin. We translate the placeholder argv tokens `@-` and `-`
 * into `--body-file <tmp>` style is unnecessary because `runSafe` already
 * supports `input: string` which `gh` consumes when given `--body-file -`
 * or `--field body=@-`.
 */
function defaultGhImpl(args: string[], opts?: { body?: string; cwd?: string }): string {
  const result = runSafe('gh', args, { cwd: opts?.cwd, input: opts?.body });
  return result ?? '';
}

// `os` is used by future temp-file fallbacks; kept imported so adding one
// later doesn't perturb the import block. Reference it once to avoid
// "unused import" warnings under strict linters.
void os;

