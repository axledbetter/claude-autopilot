// src/core/migrate/executor.ts
//
// Runs CommandSpec via spawn(shell:false). Structured argv is the only
// non-deprecated path; legacy string form goes through shell-quote with
// metachar rejection. PATH resolution is explicit; relative paths are
// resolved against the workspace cwd.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as shellParse } from 'shell-quote';
import type { CommandSpec } from './types.ts';
import { SHELL_METACHARS } from './contract.ts';

export interface ExecuteOptions {
  cwd: string;
  env?: Record<string, string>;
}

export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecutableResolution {
  found: boolean;
  absolutePath?: string;
  reason?: string;
}

/**
 * Resolve an executable name against PATH (or as a workspace-relative
 * script if the name starts with ./ or ../). Returns absolute path if
 * found.
 */
export function resolveExecutable(exec: string, cwd: string): ExecutableResolution {
  // Workspace-relative form
  if (exec.startsWith('./') || exec.startsWith('../') || path.isAbsolute(exec)) {
    const abs = path.isAbsolute(exec) ? exec : path.resolve(cwd, exec);
    if (fs.existsSync(abs)) {
      return { found: true, absolutePath: abs };
    }
    return { found: false, reason: `script not found at ${abs}` };
  }
  // PATH lookup
  const PATH = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.toLowerCase())
    : [''];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, exec + ext);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) {
          return { found: true, absolutePath: candidate };
        }
      } catch {
        // try next
      }
    }
  }
  return { found: false, reason: `'${exec}' not found in PATH` };
}

export async function executeCommand(spec: CommandSpec, opts: ExecuteOptions): Promise<ExecuteResult> {
  return new Promise(resolve => {
    const env = { ...process.env, ...(opts.env ?? {}) };
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(spec.exec, spec.args, {
        cwd: opts.cwd,
        env,
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ exitCode: -1, stdout: '', stderr: `spawn failed: ${(err as Error).message}` });
      return;
    }
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString(); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.on('error', (err: Error) => {
      resolve({ exitCode: -1, stdout, stderr: stderr + `\nspawn error: ${err.message}` });
    });
    child.on('exit', (code: number | null) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

export interface LegacyParseResult {
  spec: CommandSpec;
  warning: string;
}

/**
 * Parse a legacy string-form command via shell-quote. Rejects strings
 * containing any shell metachar — those are valid in shell but dangerous
 * in a structured-argv contract. Emits a deprecation warning.
 */
export function parseLegacyCommand(raw: string): LegacyParseResult {
  if (SHELL_METACHARS.test(raw)) {
    throw new Error(
      `shell metachar in legacy command: '${raw}'. Forbidden — convert to structured argv form { exec, args[] }.`
    );
  }
  const tokens = shellParse(raw);
  if (tokens.length === 0) {
    throw new Error('empty command string');
  }
  // shell-quote returns string | { op: '...' } | { comment: '...' };
  // we already filtered metachars so all tokens should be strings.
  if (tokens.some(t => typeof t !== 'string')) {
    throw new Error(`unparseable legacy command: '${raw}'`);
  }
  const [exec, ...args] = tokens as string[];
  return {
    spec: { exec: exec!, args },
    warning: `legacy string command form is deprecated; convert to { exec, args } structured argv. Auto-fix available via \`claude-autopilot doctor --fix\`.`,
  };
}
