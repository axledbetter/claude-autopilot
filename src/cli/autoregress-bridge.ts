// src/cli/autoregress-bridge.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { findPackageRoot } from './_pkg-root.ts';

// Resolve autoregress.ts via the canonical package root walker — works under
// both source (src/cli/...) and compiled (dist/src/cli/...) layouts. The prior
// `path.resolve(__dirname, '../../scripts/autoregress.ts')` worked from source
// but resolved to `dist/scripts/autoregress.ts` under the compiled layout (the
// shipped scripts/ lives at the package root, not under dist/), so global
// installs got ERR_MODULE_NOT_FOUND on every `claude-autopilot autoregress`.
function resolveScript(): string {
  const root = findPackageRoot(import.meta.url);
  if (root) {
    const p = path.join(root, 'scripts', 'autoregress.ts');
    if (fs.existsSync(p)) return p;
  }
  // Last-resort fallback for non-standard layouts (linked dev installs, etc.)
  return 'scripts/autoregress.ts';
}

const VALID_MODES = ['run', 'update', 'generate', 'diff'];

export function buildAutoregressArgs(args: string[]): string[] {
  const mode = args[0] && VALID_MODES.includes(args[0]) ? args[0] : 'run';
  const rest = args[0] && VALID_MODES.includes(args[0]) ? args.slice(1) : args;
  return [mode, ...rest];
}

export function runAutoregress(args: string[]): number {
  const resolvedArgs = buildAutoregressArgs(args);
  const script = resolveScript();
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', script, ...resolvedArgs],
    { stdio: 'inherit', cwd: process.cwd() },
  );
  if (result.error) {
    console.error(`[autoregress] failed to launch: ${result.error.message}`);
    console.error(`  script: ${script}`);
    return 1;
  }
  return result.status ?? 1;
}
