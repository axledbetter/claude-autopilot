// src/cli/autoregress-bridge.ts
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/autoregress.ts');

const VALID_MODES = ['run', 'update', 'generate', 'diff'];

export function buildAutoregressArgs(args: string[]): string[] {
  const mode = args[0] && VALID_MODES.includes(args[0]) ? args[0] : 'run';
  const rest = args[0] && VALID_MODES.includes(args[0]) ? args.slice(1) : args;
  return [mode, ...rest];
}

export async function runAutoregress(args: string[]): Promise<number> {
  const resolvedArgs = buildAutoregressArgs(args);
  const result = spawnSync(
    'node',
    ['--import', 'tsx', SCRIPT, ...resolvedArgs],
    { stdio: 'inherit', cwd: process.cwd() },
  );
  return result.status ?? 1;
}
