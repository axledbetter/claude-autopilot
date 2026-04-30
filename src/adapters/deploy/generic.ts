// src/adapters/deploy/generic.ts
//
// Generic deploy adapter — runs an arbitrary shell command and reports back.
//
// Wraps the v5.3 "deployCommand" approach as a DeployAdapter so the same
// CLI surface (`claude-autopilot deploy`) works whether you have a Vercel
// project, a Fly app with `flyctl deploy`, a custom `make deploy`, or anything
// else that prints a URL to stdout.
//
// `status()` and `rollback()` are deliberately omitted — without platform-API
// state we have no way to answer "is the build still going" or "promote the
// previous deploy". Callers that need those can switch to a platform adapter.

import { spawn as defaultSpawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { GuardrailError } from '../../core/errors.ts';
import type { DeployAdapter, DeployInput, DeployResult } from './types.ts';

/**
 * Function signature for the spawn dependency. Tests inject a fake spawn that
 * emits canned stdout/exit events without touching the real OS process API.
 */
export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { shell: boolean | string; signal?: AbortSignal },
) => ChildProcessByStdio<Writable | null, Readable | null, Readable | null>;

export interface GenericDeployAdapterOptions {
  /** Free-form shell command (e.g. `vercel --prod`). Required. */
  deployCommand: string;
  /** Optional health-check URL — accepted for forward-compat with Phase 4; unused in Phase 1. */
  healthCheckUrl?: string;
  /** Injected spawn implementation (defaults to `node:child_process` spawn). */
  spawnImpl?: SpawnFn;
  /** When true, suppress teeing child stdout/stderr to the parent's process streams. Tests pass true. */
  quiet?: boolean;
  /** Wall-clock source. Tests pass a controllable counter. */
  nowImpl?: () => number;
}

const URL_RE = /https?:\/\/[^\s)>"']+/i;

/**
 * Generic shell-command deploy adapter.
 *
 * Captures stdout, looks for the first http(s) URL, returns it as `deployUrl`.
 * Exit code 0 → `pass`; non-zero → `fail`.
 */
export class GenericDeployAdapter implements DeployAdapter {
  readonly name = 'generic';

  private readonly deployCommand: string;
  private readonly spawnImpl: SpawnFn;
  private readonly quiet: boolean;
  private readonly now: () => number;

  constructor(opts: GenericDeployAdapterOptions) {
    if (!opts.deployCommand || opts.deployCommand.trim() === '') {
      throw new GuardrailError(
        'Generic deploy adapter requires `deployCommand`',
        { code: 'invalid_config', provider: 'generic' },
      );
    }
    this.deployCommand = opts.deployCommand;
    this.spawnImpl = (opts.spawnImpl as SpawnFn | undefined) ?? (defaultSpawn as unknown as SpawnFn);
    this.quiet = opts.quiet ?? process.env.AUTOPILOT_DEPLOY_QUIET === '1';
    this.now = opts.nowImpl ?? Date.now;
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const start = this.now();
    return new Promise<DeployResult>((resolve, reject) => {
      let stdoutBuf = '';
      let stderrBuf = '';

      const child = this.spawnImpl(this.deployCommand, [], {
        shell: true,
        signal: input.signal,
      });

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        stdoutBuf += s;
        if (!this.quiet) process.stdout.write(s);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        stderrBuf += s;
        if (!this.quiet) process.stderr.write(s);
      });

      child.on('error', (err: Error & { code?: string }) => {
        // AbortError from a passed signal — surface as an aborted in-progress
        // result rather than a hard reject.
        if (err.name === 'AbortError') {
          resolve({
            status: 'in-progress',
            durationMs: this.now() - start,
            output: 'Deploy aborted by caller.',
          });
          return;
        }
        reject(
          new GuardrailError(
            `Generic deploy adapter failed to spawn: ${err.message}`,
            { code: 'adapter_bug', provider: 'generic', details: { errno: err.code } },
          ),
        );
      });

      child.on('close', (code: number | null) => {
        const durationMs = this.now() - start;
        const tail = lastNLines(stdoutBuf + stderrBuf, 20);
        if (code === 0) {
          const match = stdoutBuf.match(URL_RE);
          resolve({
            status: 'pass',
            deployUrl: match?.[0],
            durationMs,
            output: tail,
          });
        } else {
          resolve({
            status: 'fail',
            durationMs,
            output: tail,
          });
        }
      });
    });
  }
}

function lastNLines(s: string, n: number): string {
  const lines = s.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}
