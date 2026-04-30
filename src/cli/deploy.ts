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
export async function runDeploy(opts: RunDeployOptions): Promise<number> {
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
      return 1;
    }
  } else if (explicitConfig) {
    // Bugbot HIGH on PR #59 — when user explicitly passes --config <path> and
    // the file doesn't exist, silently skipping leads to misleading downstream
    // errors ("no deploy adapter configured", "missing project") when the real
    // problem is the config file. The default-path case stays silent (it's OK
    // to run without a config), but explicit user-provided paths must error.
    console.error(`\x1b[31m[deploy] config file not found: ${configPath}\x1b[0m`);
    return 1;
  }

  // Merge: CLI override beats config. We still want config-supplied
  // project/team/etc. when only the adapter name is overridden.
  const adapter = opts.adapterOverride ?? configBlock?.adapter;
  if (!adapter) {
    console.error(
      '\x1b[31m[deploy] no deploy adapter configured\x1b[0m\n' +
        '  hint: set `deploy.adapter` in guardrail.config.yaml, or pass --adapter <vercel|generic>',
    );
    return 1;
  }

  const merged: DeployConfig = {
    ...(configBlock ?? { adapter }),
    adapter,
  };

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
