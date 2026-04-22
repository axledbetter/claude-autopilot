#!/usr/bin/env node
/**
 * autopilot CLI — entry point
 *
 * Usage:
 *   autopilot init              scaffold autopilot.config.yaml from a preset
 *   autopilot run               run the pipeline on git-changed files
 *   autopilot run --base main   diff against a specific branch
 *   autopilot run --dry-run     show what would run, no execution
 *   autopilot watch             re-run pipeline on every file save (debounced)
 *   autopilot doctor            check prerequisites (alias: preflight)
 */
import { runCommand } from './run.ts';
import { runWatch } from './watch.ts';
import { runSetup } from './setup.ts';
import { runDoctor } from './preflight.ts';
import { runCi } from './ci.ts';

const args = process.argv.slice(2);

// Version flag — resolve from package.json at runtime
if (args[0] === '--version' || args[0] === '-v') {
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const require = createRequire(fileURLToPath(import.meta.url));
  const pkg = require('../../package.json') as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

const SUBCOMMANDS = ['init', 'run', 'ci', 'watch', 'hook', 'autoregress', 'doctor', 'preflight', 'setup', 'help', '--help', '-h'] as const;
const VALUE_FLAGS = ['base', 'config', 'files', 'format', 'output', 'debounce'];

// Detect first non-flag arg as subcommand, default to 'run'
const subcommand = (args[0] && !args[0].startsWith('--')) ? args[0] : 'run';

/** Returns value for --name <value>. Exits if value is missing (next token is another flag or absent). */
function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const val = args[idx + 1];
  if (val === undefined || val.startsWith('--')) {
    console.error(`\x1b[31m[autopilot] --${name} requires a value\x1b[0m`);
    process.exit(1);
  }
  return val;
}

function boolFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function printUsage(): void {
  console.log(`
Usage: autopilot <command> [options]

Commands:
  run          Run the pipeline on git-changed files (default)
  watch        Watch for file changes and re-run pipeline on each save
  init         Scaffold autopilot.config.yaml from a preset
  doctor       Check prerequisites and show exact fix commands (alias: preflight)
  autoregress  Run snapshot regression tests (run|diff|update|generate)

Options (run):
  --base <ref>         Git base ref for diff (default: HEAD~1)
  --config <path>      Path to config file (default: ./autopilot.config.yaml)
  --files <a,b,c>      Explicit comma-separated file list (skips git detection)
  --dry-run            Show what would run without executing
  --diff               Send git diff hunks instead of full files (~70% fewer tokens)
  --post-comments      Post/update a summary comment on the open PR
  --format <text|sarif>  Output format (default: text)
  --output <path>        Output file path (required with --format sarif)

Options (watch):
  --config <path>      Path to config file (default: ./autopilot.config.yaml)
  --debounce <ms>      Debounce delay in ms (default: 300)

Options (autoregress):
  --all                    Run/diff all snapshots
  --since <ref>            Git ref for changed-files detection
  --snapshot <slug>        Target a single snapshot
  --files <a,b,c>          Explicit file list for generate (skips git detection)
`);
}

switch (subcommand) {
  case 'init': {
    console.log('\x1b[33m[init] autopilot init is deprecated — use: npx autopilot setup\x1b[0m\n');
    const force = args.includes('--force');
    await runSetup({ force });
    break;
  }

  case 'doctor':
  case 'preflight': {
    const result = await runDoctor();
    process.exit(result.blockers > 0 ? 1 : 0);
    break;
  }

  case 'help':
  case '--help':
  case '-h':
    printUsage();
    break;

  case 'watch': {
    const config = flag('config');
    const debounceArg = flag('debounce');
    const debounceMs = debounceArg ? parseInt(debounceArg, 10) : undefined;
    if (debounceArg && (isNaN(debounceMs!) || debounceMs! < 0)) {
      console.error(`\x1b[31m[autopilot] --debounce must be a non-negative integer\x1b[0m`);
      process.exit(1);
    }
    await runWatch({ configPath: config, debounceMs });
    break;
  }

  case 'run': {
    const base = flag('base');
    const config = flag('config');
    const filesArg = flag('files');
    const dryRun = boolFlag('dry-run');
    const diff = boolFlag('diff');
    const postComments = boolFlag('post-comments');
    const formatArg = flag('format');
    const outputPath = flag('output');

    if (formatArg && formatArg !== 'text' && formatArg !== 'sarif') {
      console.error(`\x1b[31m[autopilot] --format must be "text" or "sarif"\x1b[0m`);
      process.exit(1);
    }
    if (formatArg === 'sarif' && !outputPath) {
      console.error(`\x1b[31m[autopilot] --format sarif requires --output <path>\x1b[0m`);
      process.exit(1);
    }

    const code = await runCommand({
      base,
      configPath: config,
      files: filesArg ? filesArg.split(',').map(f => f.trim()) : undefined,
      dryRun,
      diff,
      postComments,
      format: formatArg as 'text' | 'sarif' | undefined,
      outputPath,
    });
    process.exit(code);
    break;
  }

  case 'ci': {
    const base = flag('base');
    const config = flag('config');
    const outputPath = flag('output');
    const noPostComments = boolFlag('no-post-comments');
    const diff = boolFlag('diff');
    const code = await runCi({
      configPath: config,
      base,
      sarifOutput: outputPath,
      postComments: noPostComments ? false : undefined,
      diff,
    });
    process.exit(code);
    break;
  }

  case 'hook': {
    const { runHook } = await import('./hook.ts');
    const hookSub = args[1] ?? 'status';
    const force = boolFlag('force');
    const code = await runHook(hookSub, { force });
    process.exit(code);
    break;
  }

  case 'autoregress': {
    const { runAutoregress } = await import('./autoregress-bridge.ts');
    const code = runAutoregress(args.slice(1));
    process.exit(code);
    break;
  }

  case 'setup': {
    const force = args.includes('--force');
    await runSetup({ force });
    break;
  }

  default:
    console.error(`\x1b[31m[autopilot] Unknown subcommand: "${subcommand}"\x1b[0m`);
    printUsage();
    process.exit(1);
}
