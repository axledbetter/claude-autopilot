#!/usr/bin/env node
/**
 * autopilot CLI — entry point
 *
 * Usage:
 *   autopilot init              scaffold autopilot.config.yaml from a preset
 *   autopilot run               run the pipeline on git-changed files
 *   autopilot run --base main   diff against a specific branch
 *   autopilot run --dry-run     show what would run, no execution
 *   autopilot preflight         check prerequisites
 */
import { runInit } from './init.ts';
import { runCommand } from './run.ts';

const args = process.argv.slice(2);
const subcommand = args[0] ?? 'run';

// Parse flags
function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  return args[idx + 1] ?? '';
}
function boolFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

switch (subcommand) {
  case 'init':
    await runInit(process.cwd());
    break;

  case 'preflight':
    // Re-export to the existing preflight script
    await import('./preflight.ts');
    break;

  case 'run':
  default: {
    const base = flag('base');
    const config = flag('config');
    const filesArg = flag('files');
    const dryRun = boolFlag('dry-run');

    await runCommand({
      base,
      configPath: config,
      files: filesArg ? filesArg.split(',').map(f => f.trim()) : undefined,
      dryRun,
    });
    break;
  }
}
