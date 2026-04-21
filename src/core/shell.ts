// src/core/shell.ts

import { execFileSync } from 'node:child_process';
import { AutopilotError, type ErrorCode } from './errors.ts';

export interface RunOptions {
  timeout?: number;
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Run a command; return stdout on success, null on any failure. Never throws. */
export function runSafe(cmd: string, args: string[], options: RunOptions = {}): string | null {
  try {
    const result = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 60000,
      input: options.input,
      cwd: options.cwd,
      env: options.env,
    });
    return result.toString();
  } catch {
    return null;
  }
}

/** Run a command; throw AutopilotError on failure. */
export function runThrowing(cmd: string, args: string[], options: RunOptions & { errorCode?: ErrorCode; provider?: string } = {}): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 60000,
      input: options.input,
      cwd: options.cwd,
      env: options.env,
    }).toString();
  } catch (err) {
    throw new AutopilotError(`Command failed: ${cmd} ${args.join(' ')}`, {
      code: options.errorCode ?? 'transient_network',
      provider: options.provider,
      details: { cmd, args, cause: err instanceof Error ? err.message : String(err) },
    });
  }
}
