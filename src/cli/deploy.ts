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
import * as path from 'node:path';

import { GuardrailError } from '../core/errors.ts';
import { loadConfig } from '../core/config/loader.ts';
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
  adapterOverride?: 'vercel' | 'generic';
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
  adapterOverride?: 'vercel' | 'generic';
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
        '  hint: set `deploy.adapter` in guardrail.config.yaml, or pass --adapter <vercel|generic>',
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
  let streamController: AbortController | undefined;
  let streamPromise: Promise<void> | undefined;
  try {
    const factory = opts.adapterFactory ?? createDeployAdapter;
    const deployAdapter = factory(merged);

    // --watch: opt into log streaming. We start the stream from inside an
    // onDeployStart callback so it begins as soon as the platform returns
    // an ID, in parallel with the (still-running) deploy.
    let onDeployStart: ((deployId: string) => void) | undefined;
    if (opts.watch) {
      if (typeof deployAdapter.streamLogs === 'function') {
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
  } catch (err) {
    streamController?.abort();
    if (streamPromise) {
      try { await streamPromise; } catch { /* already logged */ }
    }
    console.error(formatErr(`deploy via ${adapter} failed`, err));
    return 1;
  }

  printResult(adapter, result);
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
  adapterOverride?: 'vercel' | 'generic';
  /** Specific deploy ID to roll back to. When omitted, the previous prod deploy is used. */
  to?: string;
  cwd?: string;
  /** Test seam — same contract as `RunDeployOptions.adapterFactory`. */
  adapterFactory?: (config: DeployConfig) => DeployAdapter;
}

export interface RunDeployStatusOptions {
  configPath?: string;
  adapterOverride?: 'vercel' | 'generic';
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
