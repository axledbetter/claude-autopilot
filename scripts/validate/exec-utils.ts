import { execFileSync, ExecFileSyncOptions } from 'child_process';

/**
 * Safe command execution using execFileSync (no shell injection).
 * Returns stdout as string. Throws on non-zero exit.
 */
export function run(cmd: string, args: string[], options?: ExecFileSyncOptions): string {
  return execFileSync(cmd, args, {
    encoding: 'utf-8' as const,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  }) as string;
}

/**
 * Safe command execution that returns null on error instead of throwing.
 */
export function runSafe(cmd: string, args: string[], options?: ExecFileSyncOptions): string | null {
  try {
    return run(cmd, args, options);
  } catch {
    return null;
  }
}
