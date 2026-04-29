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
import { runTriage } from './triage.ts';
import { runLsp } from './lsp.ts';
import { runWorker } from './worker.ts';
import { runTestGen } from './test-gen.ts';
import { runCouncilCmd } from './council.ts';
import { runMigrateV4 } from './migrate-v4.ts';
import { findPackageRoot } from './_pkg-root.ts';
import { GuardrailError } from '../core/errors.ts';

// Format unhandled errors as a one-line user-facing message instead of dumping a
// Node stack trace. Auth/network failures are by far the most common path here
// (bad/missing API key, rate limit, network blip) and surfacing the raw stack
// reads as "the tool is broken" when it isn't.
function formatTopLevelError(err: unknown): { message: string; exit: number } {
  if (err instanceof GuardrailError) {
    const provider = err.provider ? ` [${err.provider}]` : '';
    const hint = err.code === 'auth'
      ? '\n  hint: check your API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) or run: claude-autopilot doctor'
      : err.code === 'rate_limit'
        ? '\n  hint: rate-limited by provider — retry shortly or switch model in guardrail.config.yaml'
        : err.code === 'invalid_config'
          ? '\n  hint: check guardrail.config.yaml — claude-autopilot doctor'
          : '';
    return { message: `[claude-autopilot]${provider} ${err.code}: ${err.message}${hint}`, exit: 1 };
  }
  if (err instanceof Error) {
    return { message: `[claude-autopilot] ${err.message}`, exit: 1 };
  }
  return { message: `[claude-autopilot] ${String(err)}`, exit: 1 };
}

process.on('unhandledRejection', err => {
  const { message, exit } = formatTopLevelError(err);
  process.stderr.write(`\x1b[31m${message}\x1b[0m\n`);
  if (process.env.CLAUDE_AUTOPILOT_DEBUG === '1' && err instanceof Error && err.stack) {
    process.stderr.write(`\x1b[2m${err.stack}\x1b[0m\n`);
  }
  process.exit(exit);
});

process.on('uncaughtException', err => {
  const { message, exit } = formatTopLevelError(err);
  process.stderr.write(`\x1b[31m${message}\x1b[0m\n`);
  if (process.env.CLAUDE_AUTOPILOT_DEBUG === '1' && err.stack) {
    process.stderr.write(`\x1b[2m${err.stack}\x1b[0m\n`);
  }
  process.exit(exit);
});

const args = process.argv.slice(2);

// Version flag — read package.json via the shared package-root helper. Works
// under both source (src/cli/index.ts) and compiled (dist/src/cli/index.js)
// layouts since findPackageRoot walks up to the canonical package root.
if (args[0] === '--version' || args[0] === '-v') {
  const root = findPackageRoot(import.meta.url);
  if (root) {
    const nodeFs = await import('node:fs');
    const nodePath = await import('node:path');
    const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(root, 'package.json'), 'utf8')) as { version: string };
    console.log(pkg.version);
  } else {
    console.log('unknown');
  }
  process.exit(0);
}

// Help flag — route to help handler explicitly before subcommand defaulting.
// Without this, `--help` falls through the "args[0].startsWith('--')" check below
// and defaults to `run`, which is surprising and a v4 regression we preserve no longer.
if (args[0] === '--help' || args[0] === '-h') {
  args.unshift('help');
  args.splice(1, 1); // remove the original --help/-h token
}

// Verb grouping (new in alpha.2): `claude-autopilot review <verb>` and
// `claude-autopilot advanced <verb>` are dispatcher prefixes that route to the
// same flat handlers. Legacy flat invocation (`claude-autopilot run`) is unchanged
// — the grouped form is purely additive.
//
// Scope gates enforce that only the documented verb sets work under each prefix,
// so `claude-autopilot review doctor` is rejected with a clear error instead of
// silently routing to the doctor handler (which would confuse the mental model).
const REVIEW_VERBS = new Set(['run', 'scan', 'ci', 'fix', 'baseline', 'explain', 'watch', 'report']);
// `detector` is a library used by setup/run, not a CLI subcommand — leave it out.
const ADVANCED_VERBS = new Set(['lsp', 'mcp', 'worker', 'autoregress', 'test-gen', 'hook', 'ignore']);
if (args[0] === 'review') {
  const sub = args[1];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
Usage: claude-autopilot review <verb> [options]

Review-phase verbs:
  run          Review git-changed files (default)
  scan         Review any path — no git required
  ci           Opinionated CI entrypoint (post comments + SARIF)
  fix          Auto-fix cached findings using the configured LLM
  baseline     Manage the committed findings baseline
  explain      Deep-dive explanation + remediation for a specific finding
  watch        Watch for file changes and re-run on each save
  report       Render cached findings as a markdown report

These are aliases for the flat subcommands — \`claude-autopilot run\` and
\`claude-autopilot review run\` are equivalent.
`);
    process.exit(0);
  }
  if (!REVIEW_VERBS.has(sub)) {
    console.error(`\x1b[31m[claude-autopilot] "${sub}" is not a review-phase verb.\x1b[0m`);
    console.error(`\x1b[2m  Valid: ${[...REVIEW_VERBS].join(', ')}\x1b[0m`);
    console.error(`\x1b[2m  Did you mean: claude-autopilot ${sub} ...?\x1b[0m`);
    process.exit(1);
  }
  args.shift(); // drop 'review', leave the flat subcommand at args[0]
}
if (args[0] === 'advanced') {
  const sub = args[1];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`
Usage: claude-autopilot advanced <verb> [options]

Advanced / niche verbs (hidden from top-level --help to keep it readable):
  lsp          Language server — publishes findings as LSP diagnostics
  mcp          MCP server for Claude / ChatGPT integration
  worker       Persistent review daemon (start|stop|status)
  autoregress  Snapshot regression tests
  test-gen     Generate test cases for uncovered exports
  hook         Install / remove the pre-push git hook
  ignore       Edit the findings ignore list

These are aliases for the flat subcommands; they still work without the 'advanced' prefix.
`);
    process.exit(0);
  }
  if (!ADVANCED_VERBS.has(sub)) {
    console.error(`\x1b[31m[claude-autopilot] "${sub}" is not an advanced verb.\x1b[0m`);
    console.error(`\x1b[2m  Valid: ${[...ADVANCED_VERBS].join(', ')}\x1b[0m`);
    process.exit(1);
  }
  args.shift(); // drop 'advanced'
}

const SUBCOMMANDS = ['init', 'run', 'scan', 'report', 'explain', 'ignore', 'ci', 'pr', 'fix', 'costs', 'watch', 'hook', 'autoregress', 'baseline', 'triage', 'lsp', 'worker', 'mcp', 'test-gen', 'pr-desc', 'doctor', 'preflight', 'setup', 'council', 'migrate-v4', 'brainstorm', 'help', '--help', '-h'] as const;
const VALUE_FLAGS = ['base', 'config', 'files', 'format', 'output', 'debounce', 'ask', 'focus', 'fail-on', 'note', 'reason', 'expires', 'profile', 'severity', 'prompt', 'context-file', 'path'];

// Bare invocation — no subcommand, no flags → show welcome guide
if (args.length === 0) {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY);
  const keyLine = hasKey
    ? '\x1b[32m✓\x1b[0m  LLM API key detected'
    : '\x1b[33m!\x1b[0m  No LLM API key found — set one of:\n     ANTHROPIC_API_KEY  https://console.anthropic.com/\n     OPENAI_API_KEY     https://platform.openai.com/api-keys\n     GEMINI_API_KEY     https://aistudio.google.com/app/apikey\n     GROQ_API_KEY       https://console.groq.com/keys  (fast free tier)';
  console.log(`
\x1b[1m@delegance/claude-autopilot\x1b[0m — Autonomous dev pipeline for Claude Code
      \x1b[2m(brainstorm → spec → plan → implement → migrate → validate → PR → review)\x1b[0m

  ${keyLine}

\x1b[1mQuick start — full pipeline:\x1b[0m

  \x1b[36mclaude-autopilot brainstorm "add SSO for enterprise tenants"\x1b[0m
      Turn an idea into a reviewed spec, then auto-implement end-to-end.

\x1b[1mOr just the review phase (v4 compatible):\x1b[0m

  \x1b[36mclaude-autopilot run --base main\x1b[0m             Review files changed vs main
  \x1b[36mclaude-autopilot scan src/auth/\x1b[0m              Scan any path (no git required)
  \x1b[36mclaude-autopilot scan --ask "SQL injection?" src/db/\x1b[0m
  \x1b[36mclaude-autopilot fix\x1b[0m                         Auto-fix cached findings
  \x1b[36mclaude-autopilot migrate-v4\x1b[0m                  Codemod: migrate v4 config / CI / hooks

\x1b[1mSetup:\x1b[0m

  \x1b[36mclaude-autopilot setup\x1b[0m                       Auto-detect stack, write config, install hook
  \x1b[36mclaude-autopilot doctor\x1b[0m                      Check prerequisites

Run \x1b[36mclaude-autopilot --help\x1b[0m for full command reference.
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
    console.error(`\x1b[31m[claude-autopilot] --${name} requires a value\x1b[0m`);
    process.exit(1);
  }
  return val;
}

function boolFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function printUsage(): void {
  console.log(`
Usage: claude-autopilot <command> [options]  (legacy alias: guardrail)

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
  setup        Auto-detect stack, write config, install pre-push hook
  doctor       Check prerequisites (alias: preflight)
  preflight    Check prerequisites (alias: doctor)
  hook         Install / remove the pre-push git hook
  baseline     Manage the committed findings baseline (create|update|show|delete)
  triage       Mark individual findings as accepted/dismissed
  pr-desc      Generate a PR title / summary / test plan from the current diff
  council      Multi-model review — dispatch the diff to N models and synthesize consensus
  mcp          MCP server for Claude / ChatGPT integration
  autoregress  Snapshot regression tests (run|diff|update|generate)
  lsp          Language server — publishes findings as LSP diagnostics (stdin/stdout)
  worker       Persistent review daemon for multi-terminal parallel usage (start|stop|status)
  test-gen     Detect uncovered exports and generate test cases using the LLM

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
    if (focusArg && !['security', 'logic', 'performance', 'brand', 'all'].includes(focusArg)) {
      console.error(`\x1b[31m[claude-autopilot] --focus must be "security", "logic", "performance", or "all"\x1b[0m`);
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
      focus: focusArg as 'security' | 'logic' | 'performance' | 'brand' | 'all' | undefined,
      dryRun,
    });
    process.exit(code);
    break;
  }

  case 'init': {
    // `init` and `setup` are aliases. Keep both supported — no nag banner.
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
      console.error(`\x1b[31m[claude-autopilot] --debounce must be a non-negative integer\x1b[0m`);
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
    const staticOnly = args.includes('--static-only');
    const inlineComments = boolFlag('inline-comments');
    const postComments = boolFlag('post-comments');
    const formatArg = flag('format');
    const outputPath = flag('output');

    if (formatArg && formatArg !== 'text' && formatArg !== 'sarif' && formatArg !== 'junit') {
      console.error(`\x1b[31m[claude-autopilot] --format must be "text", "sarif", or "junit"\x1b[0m`);
      process.exit(1);
    }
    if ((formatArg === 'sarif' || formatArg === 'junit') && !outputPath) {
      console.error(`\x1b[31m[claude-autopilot] --format ${formatArg} requires --output <path>\x1b[0m`);
      process.exit(1);
    }

    const failOnArg = flag('fail-on');
    if (failOnArg && !['critical', 'warning', 'note', 'none'].includes(failOnArg)) {
      console.error(`\x1b[31m[claude-autopilot] --fail-on must be "critical", "warning", "note", or "none"\x1b[0m`);
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
      format: formatArg as 'text' | 'sarif' | 'junit' | undefined,
      outputPath,
      skipReview: staticOnly,
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
    const code = await runHook(hookSub, {
      force,
      preCommitOnly: args.includes('--pre-commit-only'),
      prePushOnly: args.includes('--pre-push-only'),
    });
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
      console.error(`\x1b[31m[claude-autopilot] --severity must be "critical", "warning", or "all"\x1b[0m`);
      process.exit(1);
    }
    const dryRun = boolFlag('dry-run');
    const noVerify = boolFlag('no-verify');
    const code = await runFix({
      configPath: config,
      severity: severityArg as 'critical' | 'warning' | 'all' | undefined,
      dryRun,
      noVerify,
    });
    process.exit(code);
    break;
  }

  case 'triage': {
    const sub = args[1];
    const rest = args.slice(2);
    const code = await runTriage(sub, rest);
    process.exit(code);
    break;
  }

  case 'test-gen': {
    const config = flag('config');
    const base = flag('base');
    const dryRun = boolFlag('dry-run');
    const verify = boolFlag('verify');
    const targets = args.slice(1).filter(a => !a.startsWith('--') && a !== config && a !== base);
    const code = await runTestGen({
      cwd: process.cwd(),
      configPath: config,
      targets: targets.length > 0 ? targets : undefined,
      base,
      dryRun,
      verify,
    });
    process.exit(code);
    break;
  }

  case 'pr-desc': {
    const { runPrDesc } = await import('./pr-desc.ts');
    const baseIdx = args.indexOf('--base');
    const base = baseIdx !== -1 ? args[baseIdx + 1] : undefined;
    const outputIdx = args.indexOf('--output');
    const output = outputIdx !== -1 ? args[outputIdx + 1] : undefined;
    await runPrDesc({
      base,
      post: args.includes('--post'),
      yes: args.includes('--yes'),
      output,
    });
    break;
  }

  case 'lsp': {
    await runLsp({ cwd: process.cwd() });
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
    const profileArg = flag('profile');
    if (profileArg && !['security-strict', 'team', 'solo'].includes(profileArg)) {
      console.error(`\x1b[31m[claude-autopilot] --profile must be "security-strict", "team", or "solo"\x1b[0m`);
      process.exit(1);
    }
    await runSetup({ force, profile: profileArg as 'security-strict' | 'team' | 'solo' | undefined });
    break;
  }

  case 'worker': {
    const sub = args[1];
    const config = flag('config');
    const code = await runWorker(sub, { cwd: process.cwd(), configPath: config });
    process.exit(code);
    break;
  }

  case 'council': {
    const config = flag('config');
    const prompt = flag('prompt');
    const contextFile = flag('context-file');
    const dryRun = boolFlag('dry-run');
    const noSynthesize = boolFlag('no-synthesize');
    const code = await runCouncilCmd({
      prompt,
      contextFile,
      configPath: config,
      dryRun,
      noSynthesize,
    });
    process.exit(code);
    break;
  }

  case 'mcp': {
    const { runMcp } = await import('./mcp.ts');
    const configPath = flag('config');
    await runMcp({ cwd: process.cwd(), configPath });
    break;
  }

  case 'migrate-v4': {
    const code = await runMigrateV4({
      cwd: flag('path') ?? process.cwd(),
      write: boolFlag('write'),
      undo: boolFlag('undo'),
    });
    process.exit(code);
    break;
  }

  case 'brainstorm': {
    // `brainstorm` is the front of the pipeline and is implemented as a Claude
    // Code skill (superpowers:brainstorming → autopilot), not a standalone CLI.
    // The welcome screen advertises `claude-autopilot brainstorm "..."` as the
    // primary quickstart, so users WILL land here. Give them clear instructions
    // instead of a generic "Unknown subcommand" rejection. Only reference CLI
    // subcommands that actually route (verified by the welcome regression test).
    console.log(`
\x1b[1m[brainstorm]\x1b[0m The pipeline entry point is a Claude Code skill, not a CLI subcommand.

Invoke it from Claude Code:

  \x1b[36m/brainstorm\x1b[0m                         Interactive spec writing
  \x1b[36m/autopilot\x1b[0m                          Full pipeline from an approved spec
  \x1b[36m/migrate\x1b[0m                            Database migration phase (stack-dependent)

From the terminal, the CLI subset exposes only the individual review-phase subcommands:

  \x1b[36mclaude-autopilot run --base main\x1b[0m    Just the review phase
  \x1b[36mclaude-autopilot doctor\x1b[0m             Check prerequisites (incl. superpowers plugin)
  \x1b[36mclaude-autopilot migrate-v4\x1b[0m         Codemod for v4 → v5 repo migration (not a pipeline phase)

Full pipeline docs: https://github.com/axledbetter/claude-autopilot#the-pipeline-phase-by-phase
`);
    process.exit(0);
    break;
  }

  default:
    console.error(`\x1b[31m[claude-autopilot] Unknown subcommand: "${subcommand}"\x1b[0m`);
    printUsage();
    process.exit(1);
}
