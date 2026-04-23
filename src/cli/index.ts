#!/usr/bin/env node
/**
 * guardrail CLI — entry point
 *
 * Usage:
 *   guardrail run               review git-changed files
 *   guardrail scan src/auth/    review any path (no git required)
 *   guardrail scan --ask "..."  ask a targeted question about code
 *   guardrail ci                opinionated CI entrypoint
 *   guardrail watch             re-run on every file save
 *   guardrail doctor            check prerequisites
 */
import { runCommand } from './run.ts';
import { runWatch } from './watch.ts';
import { runSetup } from './setup.ts';
import { runDoctor } from './preflight.ts';
import { runCi } from './ci.ts';
import { runFix } from './fix.ts';
import { runScan } from './scan.ts';
import { runReport } from './report.ts';
import { runExplain } from './explain.ts';
import { runIgnore } from './ignore-helper.ts';
import { runPr } from './pr.ts';
import { runBaseline } from './baseline.ts';

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

const SUBCOMMANDS = ['init', 'run', 'scan', 'report', 'explain', 'ignore', 'ci', 'pr', 'fix', 'costs', 'watch', 'hook', 'autoregress', 'baseline', 'doctor', 'preflight', 'setup', 'help', '--help', '-h'] as const;
const VALUE_FLAGS = ['base', 'config', 'files', 'format', 'output', 'debounce', 'ask', 'focus', 'fail-on', 'note'];

// Bare invocation — no subcommand, no flags → show welcome guide
if (args.length === 0) {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY);
  const keyLine = hasKey
    ? '\x1b[32m✓\x1b[0m  LLM API key detected'
    : '\x1b[33m!\x1b[0m  No LLM API key found — set one of:\n     ANTHROPIC_API_KEY  https://console.anthropic.com/\n     OPENAI_API_KEY     https://platform.openai.com/api-keys\n     GEMINI_API_KEY     https://aistudio.google.com/app/apikey\n     GROQ_API_KEY       https://console.groq.com/keys  (fast free tier)';
  console.log(`
\x1b[1m@delegance/guardrail\x1b[0m — LLM-powered code review for your PR diffs

  ${keyLine}

\x1b[1mQuick start:\x1b[0m

  \x1b[36mnpx guardrail run --base main\x1b[0m          Review files changed vs main
  \x1b[36mnpx guardrail scan src/auth/\x1b[0m           Scan any path (no git required)
  \x1b[36mnpx guardrail scan --ask "SQL injection?" src/db/\x1b[0m
  \x1b[36mnpx guardrail fix\x1b[0m                      Auto-fix cached findings

\x1b[1mSetup:\x1b[0m

  \x1b[36mnpx guardrail setup\x1b[0m                    Auto-detect stack, write config, install hook
  \x1b[36mnpx guardrail doctor\x1b[0m                   Check prerequisites

Run \x1b[36mnpx guardrail --help\x1b[0m for full command reference.
`);
  process.exit(0);
}

// Detect first non-flag arg as subcommand, default to 'run'
const subcommand = (args[0] && !args[0].startsWith('--')) ? args[0] : 'run';

/** Returns value for --name <value>. Exits if value is missing (next token is another flag or absent). */
function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const val = args[idx + 1];
  if (val === undefined || val.startsWith('--')) {
    console.error(`\x1b[31m[guardrail] --${name} requires a value\x1b[0m`);
    process.exit(1);
  }
  return val;
}

function boolFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function printUsage(): void {
  console.log(`
Usage: guardrail <command> [options]

Commands:
  run          Review git-changed files (default)
  scan         Review any path — no git required
  report       Render cached findings as a markdown report
  explain      Deep-dive explanation + remediation for a specific finding
  ignore       Interactively add findings to .guardrail-ignore
  watch        Watch for file changes and re-run on each save
  pr           Review a specific PR by number (auto-detects if on PR branch)
  fix          Auto-fix cached findings using the configured LLM
  costs        Show per-run cost summary
  ci           Opinionated CI entrypoint (post comments + SARIF)
  init         Scaffold guardrail.config.yaml from a preset
  doctor       Check prerequisites (alias: preflight)
  autoregress  Snapshot regression tests (run|diff|update|generate)

Options (run):
  --base <ref>         Git base ref for diff (default: HEAD~1)
  --config <path>      Path to config file (default: ./guardrail.config.yaml)
  --files <a,b,c>      Explicit comma-separated file list (skips git detection)
  --dry-run            Show what would run without executing
  --diff               Send git diff hunks instead of full files (~70% fewer tokens)
  --delta              Only report findings new since last run (suppress pre-existing)
  --inline-comments    Post per-line review comments on the PR diff
  --post-comments      Post/update a summary comment on the open PR
  --format <text|sarif>  Output format (default: text)
  --output <path>        Output file path (required with --format sarif)

Options (scan):
  <path> [path...]     Files or directories to scan (or --all for entire codebase)
  --all                Scan entire codebase
  --ask <question>     Targeted question to inject into the LLM review prompt
  --focus <type>       security | logic | performance (default: all)
  --dry-run            List files that would be scanned without running
  --config <path>      Path to config file

Options (pr):
  <number>                   PR number to review (optional if on a PR branch)
  --no-post-comments         Skip posting/updating PR summary comment
  --no-inline-comments       Skip posting per-line inline annotations
  --config <path>            Path to config file

Options (fix):
  --severity <critical|warning|all>  Which findings to fix (default: critical)
  --dry-run                          Preview fixes without writing files
  --config <path>                    Path to config file

Options (watch):
  --config <path>      Path to config file (default: ./guardrail.config.yaml)
  --debounce <ms>      Debounce delay in ms (default: 300)

Options (autoregress):
  --all                    Run/diff all snapshots
  --since <ref>            Git ref for changed-files detection
  --snapshot <slug>        Target a single snapshot
  --files <a,b,c>          Explicit file list for generate (skips git detection)
`);
}

switch (subcommand) {
  case 'scan': {
    const config = flag('config');
    const ask = flag('ask');
    const focusArg = flag('focus');
    if (focusArg && !['security', 'logic', 'performance', 'all'].includes(focusArg)) {
      console.error(`\x1b[31m[guardrail] --focus must be "security", "logic", "performance", or "all"\x1b[0m`);
      process.exit(1);
    }
    const dryRun = boolFlag('dry-run');
    const all = boolFlag('all');
    // Remaining non-flag args after 'scan' are paths
    const targets = args.slice(1).filter(a => !a.startsWith('--') && a !== ask && a !== focusArg && a !== config);
    const code = await runScan({
      configPath: config,
      targets: targets.length > 0 ? targets : undefined,
      all,
      ask,
      focus: focusArg as 'security' | 'logic' | 'performance' | 'all' | undefined,
      dryRun,
    });
    process.exit(code);
    break;
  }

  case 'init': {
    console.log('\x1b[33m[init] guardrail init is deprecated — use: npx guardrail setup\x1b[0m\n');
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
      console.error(`\x1b[31m[guardrail] --debounce must be a non-negative integer\x1b[0m`);
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
    const delta = boolFlag('delta');
    const inlineComments = boolFlag('inline-comments');
    const postComments = boolFlag('post-comments');
    const formatArg = flag('format');
    const outputPath = flag('output');

    if (formatArg && formatArg !== 'text' && formatArg !== 'sarif') {
      console.error(`\x1b[31m[guardrail] --format must be "text" or "sarif"\x1b[0m`);
      process.exit(1);
    }
    if (formatArg === 'sarif' && !outputPath) {
      console.error(`\x1b[31m[guardrail] --format sarif requires --output <path>\x1b[0m`);
      process.exit(1);
    }

    const failOnArg = flag('fail-on');
    if (failOnArg && !['critical', 'warning', 'note', 'none'].includes(failOnArg)) {
      console.error(`\x1b[31m[guardrail] --fail-on must be "critical", "warning", "note", or "none"\x1b[0m`);
      process.exit(1);
    }
    const newOnly = boolFlag('new-only');

    const code = await runCommand({
      base,
      configPath: config,
      files: filesArg ? filesArg.split(',').map(f => f.trim()) : undefined,
      dryRun,
      diff,
      delta,
      newOnly,
      failOn: failOnArg as 'critical' | 'warning' | 'note' | 'none' | undefined,
      inlineComments,
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
    const noInlineComments = boolFlag('no-inline-comments');
    const diff = boolFlag('diff');
    const newOnly = boolFlag('new-only');
    const failOnArg = flag('fail-on');
    const code = await runCi({
      configPath: config,
      base,
      sarifOutput: outputPath,
      postComments: noPostComments ? false : undefined,
      inlineComments: noInlineComments ? false : undefined,
      diff,
      newOnly,
      failOn: failOnArg as 'critical' | 'warning' | 'note' | 'none' | undefined,
    });
    process.exit(code);
    break;
  }

  case 'baseline': {
    const { runBaseline: rb } = await import('./baseline.ts');
    const sub = args[1] ?? 'show';
    const note = flag('note');
    const config = flag('config');
    const code = await rb(sub, { cwd: process.cwd(), note, baselinePath: config });
    process.exit(code);
    break;
  }

  case 'pr': {
    const config = flag('config');
    const noPostComments = boolFlag('no-post-comments');
    const noInlineComments = boolFlag('no-inline-comments');
    const prNumber = args.slice(1).find(a => !a.startsWith('--') && /^\d+$/.test(a));
    const code = await runPr({
      configPath: config,
      prNumber,
      noPostComments,
      noInlineComments,
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

  case 'fix': {
    const config = flag('config');
    const severityArg = flag('severity');
    if (severityArg && !['critical', 'warning', 'all'].includes(severityArg)) {
      console.error(`\x1b[31m[guardrail] --severity must be "critical", "warning", or "all"\x1b[0m`);
      process.exit(1);
    }
    const dryRun = boolFlag('dry-run');
    const code = await runFix({
      configPath: config,
      severity: severityArg as 'critical' | 'warning' | 'all' | undefined,
      dryRun,
    });
    process.exit(code);
    break;
  }

  case 'costs': {
    const { runCosts } = await import('./costs.ts');
    const code = await runCosts();
    process.exit(code);
    break;
  }

  case 'report': {
    const outputPath = flag('output');
    const trend = boolFlag('trend');
    const code = await runReport({ output: outputPath, trend });
    process.exit(code);
    break;
  }

  case 'explain': {
    const config = flag('config');
    // Target is the first non-flag arg after 'explain'
    const target = args.slice(1).find(a => !a.startsWith('--'));
    const code = await runExplain({ configPath: config, target });
    process.exit(code);
    break;
  }

  case 'ignore': {
    const all = boolFlag('all');
    const dryRun = boolFlag('dry-run');
    const code = await runIgnore({ all, dryRun });
    process.exit(code);
    break;
  }

  case 'setup': {
    const force = args.includes('--force');
    await runSetup({ force });
    break;
  }

  default:
    console.error(`\x1b[31m[guardrail] Unknown subcommand: "${subcommand}"\x1b[0m`);
    printUsage();
    process.exit(1);
}
