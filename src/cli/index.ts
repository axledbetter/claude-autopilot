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
import { runMigrateDoctor } from './migrate-doctor.ts';
import { initMigrate, NoMigrationToolDetectedError } from './init-migrate.ts';
import { dispatch as runMigrateDispatch } from '../core/migrate/dispatcher.ts';
import { runDeploy, runDeployRollback, runDeployStatus } from './deploy.ts';
import { findPackageRoot } from './_pkg-root.ts';
import { GuardrailError } from '../core/errors.ts';
import { buildHelpText, buildCommandHelpText } from './help-text.ts';
import { runUnderJsonMode, EXIT_NEEDS_HUMAN } from './json-envelope.ts';

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

// `internal` is a hidden verb (v6 Phase 2): markdown-driven skills shell out
// to it to append typed events. Deliberately not in HELP_GROUPS / HELP_VERBS,
// not advertised in the welcome banner. Documented only via
// `claude-autopilot internal --help`.
//
// `runs` (plural) is the v6 Phase 3 umbrella verb — its sub-verbs (list, show,
// gc, delete, doctor) are dispatched inside its case block. The singular
// `run resume` form is handled BEFORE the default `run` -> review dispatch
// kicks in (see disambiguation block just below).
const SUBCOMMANDS = ['init', 'run', 'runs', 'scan', 'report', 'explain', 'ignore', 'ci', 'pr', 'fix', 'costs', 'watch', 'hook', 'autoregress', 'baseline', 'triage', 'lsp', 'worker', 'mcp', 'test-gen', 'pr-desc', 'doctor', 'preflight', 'setup', 'council', 'migrate-v4', 'migrate', 'migrate-doctor', 'deploy', 'brainstorm', 'internal', 'help', '--help', '-h'] as const;
const VALUE_FLAGS = ['base', 'config', 'files', 'format', 'output', 'debounce', 'ask', 'focus', 'fail-on', 'note', 'reason', 'expires', 'profile', 'severity', 'prompt', 'context-file', 'path', 'adapter', 'ref', 'sha'];

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

// Detect first non-flag arg as subcommand, default to 'run'.
//
// v6 Phase 3 disambiguation: `run resume <id>` is a v6 verb; the bare `run`
// remains the legacy review-phase entry point. We rewrite the head to a
// synthetic 'run-resume' subcommand so the existing 'run' case keeps doing
// `runReview` and we don't need to special-case it inside the review path.
let subcommand = (args[0] && !args[0].startsWith('--')) ? args[0] : 'run';
if (subcommand === 'run' && args[1] === 'resume') {
  subcommand = 'run-resume';
}

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

/**
 * Parse the `--engine` / `--no-engine` flag pair into a tri-state.
 *
 * Returns:
 *   - true  if `--engine` was passed
 *   - false if `--no-engine` was passed
 *   - undefined if neither was passed
 *
 * If BOTH are passed, exits 1 with `invalid_config` — the spec is explicit
 * that this is single-version-supported, you can't ask for both at once.
 */
function parseEngineCliFlag(): boolean | undefined {
  const on = args.includes('--engine');
  const off = args.includes('--no-engine');
  if (on && off) {
    console.error(
      `\x1b[31m[claude-autopilot] invalid_config: --engine and --no-engine cannot both be passed\x1b[0m`,
    );
    console.error(
      `\x1b[2m  hint: pass exactly one. Precedence: CLI > env > config > default.\x1b[0m`,
    );
    process.exit(1);
  }
  if (on) return true;
  if (off) return false;
  return undefined;
}

/**
 * Run the migrate-doctor with shared CLI formatting and exit handling.
 *
 * Both `migrate doctor` (two-word) and `migrate-doctor` (single-verb alias)
 * resolve to this helper to keep their behavior locked together.
 *
 * Phase 5: also handles --json (envelope on stdout, no human banner).
 */
async function runMigrateDoctorCLI(): Promise<never> {
  const fix = args.includes('--fix');
  const json = args.includes('--json');
  let docResult: Awaited<ReturnType<typeof runMigrateDoctor>> | null = null;
  const code = await runUnderJsonMode(
    {
      command: 'migrate-doctor',
      active: json,
      payload: () => docResult ? {
        results: docResult.results,
        mutations: docResult.mutations ?? [],
        migrationReportPath: docResult.migrationReportPath,
        allOk: docResult.allOk,
      } : {},
      statusFor: exit => exit === 0 ? 'pass' : 'fail',
    },
    async () => {
      docResult = await runMigrateDoctor({ repoRoot: process.cwd(), fix });
      for (const r of docResult.results) {
        const mark = r.result.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
        console.log(`${mark} ${r.name}${r.result.message ? ` — ${r.result.message}` : ''}`);
        if (!r.result.ok && r.result.fixHint) {
          console.log(`  \x1b[2mhint: ${r.result.fixHint}\x1b[0m`);
        }
      }
      if (docResult.mutations && docResult.mutations.length > 0) {
        console.log(`\n\x1b[1mFixes applied:\x1b[0m`);
        for (const m of docResult.mutations) console.log(`  - ${m}`);
      }
      if (docResult.migrationReportPath) {
        console.log(`\n\x1b[2mMigration report: ${docResult.migrationReportPath}\x1b[0m`);
      }
      return docResult.allOk ? 0 : 1;
    },
  );
  process.exit(code);
}

function printUsage(): void {
  process.stdout.write(buildHelpText());
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
    const json = boolFlag('json');
    // v6.0.1 — engine knob. CLI flag wins; env / config / default resolved
    // inside runScan once it's loaded the config file.
    const cliEngine = parseEngineCliFlag();
    // Remaining non-flag args after 'scan' are paths
    const targets = args.slice(1).filter(a => !a.startsWith('--') && a !== ask && a !== focusArg && a !== config);
    const code = await runUnderJsonMode(
      { command: 'scan', active: json },
      () => runScan({
        configPath: config,
        targets: targets.length > 0 ? targets : undefined,
        all,
        ask,
        focus: focusArg as 'security' | 'logic' | 'performance' | 'brand' | 'all' | undefined,
        dryRun,
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      }),
    );
    process.exit(code);
    break;
  }

  case 'init': {
    // `init` and `setup` are aliases. Keep both supported — no nag banner.
    const force = args.includes('--force');
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'init', active: json },
      async () => {
        await runSetup({ force });

        // After the existing init/setup logic, sniff for a migration tool and write
        // .autopilot/stack.md. Non-interactive: high-confidence single matches are
        // auto-selected; ambiguity / no-match downgrades to a TODO 'none@1' shape so
        // we don't block the user. (Interactive prompts come from the autopilot skill,
        // not the CLI.)
        try {
          const result = await initMigrate({
            repoRoot: process.cwd(),
            force,
          });
          for (const ws of result.workspaces) {
            const rel = ws.workspace === process.cwd() ? '.' : ws.workspace;
            console.log(`\x1b[2m[init-migrate] ${ws.action} ${rel}/.autopilot/stack.md (skill: ${ws.skill})\x1b[0m`);
          }
        } catch (err) {
          if (err instanceof NoMigrationToolDetectedError) {
            // No high-confidence match — fall back to skipMigrate shape so the user
            // can edit it later. This matches the auto-detection contract documented
            // in the v5.2.0 CHANGELOG.
            try {
              await initMigrate({
                repoRoot: process.cwd(),
                force,
                skipMigrate: true,
              });
              console.log(`\x1b[33m[init-migrate] No migration tool detected — wrote 'none@1' stack.md (edit .autopilot/stack.md to configure)\x1b[0m`);
            } catch (fallbackErr) {
              console.error(`\x1b[31m[init-migrate] failed: ${(fallbackErr as Error).message}\x1b[0m`);
              return 1;
            }
          } else {
            console.error(`\x1b[31m[init-migrate] failed: ${(err as Error).message}\x1b[0m`);
            return 1;
          }
        }
        return 0;
      },
    );
    if (json) process.exit(code);
    break;
  }

  case 'doctor':
  case 'preflight': {
    const json = boolFlag('json');
    let docResult: Awaited<ReturnType<typeof runDoctor>> | null = null;
    const code = await runUnderJsonMode(
      {
        command: subcommand,
        active: json,
        payload: () => docResult ? {
          blockers: docResult.blockers,
          warnings: docResult.warnings,
        } : {},
      },
      async () => {
        docResult = await runDoctor();
        return docResult.blockers > 0 ? 1 : 0;
      },
    );
    process.exit(code);
    break;
  }

  case 'help':
  case '--help':
  case '-h': {
    // `claude-autopilot help <command>` — focused per-command help. Falls back
    // to the full two-level listing with an "unknown command" notice + exit 1
    // when the named verb isn't documented.
    const target = args[1];
    if (target && !target.startsWith('-')) {
      const focused = buildCommandHelpText(target);
      if (focused !== null) {
        process.stdout.write(focused);
        process.exit(0);
      }
      process.stderr.write(`\x1b[31m[claude-autopilot] unknown command: "${target}"\x1b[0m\n`);
      process.stdout.write(buildHelpText());
      process.exit(1);
    }
    printUsage();
    break;
  }

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
    const json = boolFlag('json');

    const code = await runUnderJsonMode(
      { command: 'run', active: json },
      () => runCommand({
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
      }),
    );
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
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'ci', active: json },
      () => runCi({
        configPath: config,
        base,
        sarifOutput: outputPath,
        postComments: noPostComments ? false : undefined,
        inlineComments: noInlineComments ? false : undefined,
        diff,
        newOnly,
        failOn: failOnArg as 'critical' | 'warning' | 'note' | 'none' | undefined,
      }),
    );
    process.exit(code);
    break;
  }

  case 'baseline': {
    const { runBaseline: rb } = await import('./baseline.ts');
    const sub = args[1] ?? 'show';
    const note = flag('note');
    const config = flag('config');
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: `baseline ${sub}`, active: json },
      () => rb(sub, { cwd: process.cwd(), note, baselinePath: config }),
    );
    process.exit(code);
    break;
  }

  case 'pr': {
    const config = flag('config');
    const noPostComments = boolFlag('no-post-comments');
    const noInlineComments = boolFlag('no-inline-comments');
    const json = boolFlag('json');
    const prNumber = args.slice(1).find(a => !a.startsWith('--') && /^\d+$/.test(a));
    const code = await runUnderJsonMode(
      { command: 'pr', active: json },
      () => runPr({
        configPath: config,
        prNumber,
        noPostComments,
        noInlineComments,
      }),
    );
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
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'fix', active: json },
      () => runFix({
        configPath: config,
        severity: severityArg as 'critical' | 'warning' | 'all' | undefined,
        dryRun,
        noVerify,
      }),
    );
    process.exit(code);
    break;
  }

  case 'triage': {
    const sub = args[1];
    const rest = args.slice(2);
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: `triage${sub ? ` ${sub}` : ''}`, active: json },
      () => runTriage(sub, rest),
    );
    process.exit(code);
    break;
  }

  case 'test-gen': {
    const config = flag('config');
    const base = flag('base');
    const dryRun = boolFlag('dry-run');
    const verify = boolFlag('verify');
    const json = boolFlag('json');
    const targets = args.slice(1).filter(a => !a.startsWith('--') && a !== config && a !== base);
    const code = await runUnderJsonMode(
      { command: 'test-gen', active: json },
      () => runTestGen({
        cwd: process.cwd(),
        configPath: config,
        targets: targets.length > 0 ? targets : undefined,
        base,
        dryRun,
        verify,
      }),
    );
    process.exit(code);
    break;
  }

  case 'pr-desc': {
    const { runPrDesc } = await import('./pr-desc.ts');
    const baseIdx = args.indexOf('--base');
    const base = baseIdx !== -1 ? args[baseIdx + 1] : undefined;
    const outputIdx = args.indexOf('--output');
    const output = outputIdx !== -1 ? args[outputIdx + 1] : undefined;
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'pr-desc', active: json },
      async () => {
        await runPrDesc({
          base,
          post: args.includes('--post'),
          yes: args.includes('--yes'),
          output,
        });
        return 0;
      },
    );
    if (json) process.exit(code);
    break;
  }

  case 'lsp': {
    await runLsp({ cwd: process.cwd() });
    break;
  }

  case 'costs': {
    const { runCosts } = await import('./costs.ts');
    const json = boolFlag('json');
    const config = flag('config');
    // v6.0.2 — engine knob. CLI flag wins; env / config / default resolved
    // inside runCosts once it's loaded the config file.
    const cliEngine = parseEngineCliFlag();
    const code = await runUnderJsonMode(
      { command: 'costs', active: json },
      () => runCosts({
        ...(config !== undefined ? { configPath: config } : {}),
        ...(cliEngine !== undefined ? { cliEngine } : {}),
        envEngine: process.env.CLAUDE_AUTOPILOT_ENGINE,
      }),
    );
    process.exit(code);
    break;
  }

  case 'report': {
    const outputPath = flag('output');
    const trend = boolFlag('trend');
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'report', active: json },
      () => runReport({ output: outputPath, trend }),
    );
    process.exit(code);
    break;
  }

  case 'explain': {
    const config = flag('config');
    const json = boolFlag('json');
    // Target is the first non-flag arg after 'explain'
    const target = args.slice(1).find(a => !a.startsWith('--'));
    const code = await runUnderJsonMode(
      { command: 'explain', active: json },
      () => runExplain({ configPath: config, target }),
    );
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
    const json = boolFlag('json');
    if (profileArg && !['security-strict', 'team', 'solo'].includes(profileArg)) {
      console.error(`\x1b[31m[claude-autopilot] --profile must be "security-strict", "team", or "solo"\x1b[0m`);
      process.exit(1);
    }
    const code = await runUnderJsonMode(
      { command: 'setup', active: json },
      async () => {
        await runSetup({ force, profile: profileArg as 'security-strict' | 'team' | 'solo' | undefined });
        return 0;
      },
    );
    if (json) process.exit(code);
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
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'council', active: json },
      () => runCouncilCmd({
        prompt,
        contextFile,
        configPath: config,
        dryRun,
        noSynthesize,
      }),
    );
    process.exit(code);
    break;
  }

  case 'mcp': {
    let runMcp: (opts: { cwd: string; configPath?: string }) => Promise<void>;
    try {
      ({ runMcp } = await import('./mcp.ts'));
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      const msg = (err as Error).message ?? String(err);
      // The mcp module imports @modelcontextprotocol/sdk at the top — if the
      // package was installed with --omit=optional the dynamic import surfaces
      // ERR_MODULE_NOT_FOUND naming the SDK. Translate to a friendly hint.
      if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && /modelcontextprotocol/.test(msg)) {
        console.error('\x1b[31m[claude-autopilot] mcp subcommand requires @modelcontextprotocol/sdk\x1b[0m');
        console.error('  install: npm install @modelcontextprotocol/sdk');
        process.exit(1);
      }
      throw err;
    }
    const configPath = flag('config');
    await runMcp({ cwd: process.cwd(), configPath });
    break;
  }

  case 'migrate-v4': {
    const json = boolFlag('json');
    const code = await runUnderJsonMode(
      { command: 'migrate-v4', active: json },
      () => runMigrateV4({
        cwd: flag('path') ?? process.cwd(),
        write: boolFlag('write'),
        undo: boolFlag('undo'),
      }),
    );
    process.exit(code);
    break;
  }

  case 'migrate': {
    // Two-word `migrate doctor` is dispatched here before the generic migrate
    // path so we don't try to read a stack.md or pick an env when the user is
    // really asking for the doctor. `migrate-doctor` (single verb, below) is
    // an equivalent alias.
    if (args[1] === 'doctor') {
      await runMigrateDoctorCLI();
      break;
    }

    // Plain `migrate [--env <name>] [--dry-run] [--yes]` → dispatcher.
    const envName = flag('env') ?? 'dev';
    const dryRun = boolFlag('dry-run');
    const yesFlag = boolFlag('yes');
    const json = boolFlag('json');

    // Read package version for the runtime handshake.
    const root = findPackageRoot(import.meta.url);
    let runtimeVersion = 'unknown';
    if (root) {
      try {
        const nodeFs = await import('node:fs');
        const nodePath = await import('node:path');
        const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(root, 'package.json'), 'utf8')) as { version: string };
        runtimeVersion = pkg.version;
      } catch {
        /* fall through with 'unknown' — handshake will fail closed */
      }
    }

    // Capture migrate result in an outer ref so the wrapper's payload
    // callback can surface its structured fields in --json mode.
    let migrateResult: Awaited<ReturnType<typeof runMigrateDispatch>> | null = null;
    const code = await runUnderJsonMode(
      {
        command: 'migrate',
        active: json,
        payload: () => migrateResult ? {
          migrate: {
            status: migrateResult.status,
            reasonCode: migrateResult.reasonCode,
            appliedMigrations: migrateResult.appliedMigrations,
            nextActions: migrateResult.nextActions,
          },
          ...(migrateResult.nextActions.length > 0 ? { nextActions: migrateResult.nextActions } : {}),
        } : {},
        statusFor: exit => {
          if (!migrateResult) return exit === 0 ? 'pass' : 'fail';
          return migrateResult.status === 'applied' || migrateResult.status === 'skipped' ? 'pass' : 'fail';
        },
      },
      async () => {
        migrateResult = await runMigrateDispatch({
          repoRoot: process.cwd(),
          env: envName,
          yesFlag,
          nonInteractive: json || !process.stdin.isTTY,
          currentRuntimeVersion: runtimeVersion,
          dryRun,
        });

        const ok = migrateResult.status === 'applied' || migrateResult.status === 'skipped';
        const color = ok ? '\x1b[32m' : '\x1b[31m';
        console.log(`${color}[migrate] status=${migrateResult.status} reason=${migrateResult.reasonCode}\x1b[0m`);
        if (migrateResult.appliedMigrations.length > 0) {
          console.log(`  applied: ${migrateResult.appliedMigrations.join(', ')}`);
        }
        if (migrateResult.nextActions.length > 0) {
          console.log(`  next: ${migrateResult.nextActions.join('; ')}`);
        }
        return ok ? 0 : 1;
      },
    );
    process.exit(code);
    break;
  }

  case 'migrate-doctor': {
    // Single-verb alias for `migrate doctor`. Documented for users whose shells
    // or CI configs handle multi-word verbs awkwardly.
    await runMigrateDoctorCLI();
    break;
  }

  case 'deploy': {
    const config = flag('config');
    const adapterArg = flag('adapter');
    // Keep this list in sync with `DeployConfig.adapter` in
    // src/adapters/deploy/types.ts and the factory in
    // src/adapters/deploy/index.ts.
    const ADAPTER_NAMES = ['vercel', 'fly', 'render', 'generic'] as const;
    type AdapterName = typeof ADAPTER_NAMES[number];
    if (adapterArg && !ADAPTER_NAMES.includes(adapterArg as AdapterName)) {
      console.error(
        `\x1b[31m[claude-autopilot] --adapter must be one of: ${ADAPTER_NAMES.join(', ')}\x1b[0m`,
      );
      process.exit(1);
    }
    // Phase 3 — `deploy rollback` and `deploy status` subverbs. The first
    // non-flag positional after `deploy` selects the verb. The historic
    // `claude-autopilot deploy` (no subverb) keeps calling runDeploy.
    const subverb = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const json = boolFlag('json');
    if (subverb === 'rollback') {
      const to = flag('to');
      const code = await runUnderJsonMode(
        { command: 'deploy rollback', active: json },
        () => runDeployRollback({
          configPath: config,
          adapterOverride: adapterArg as AdapterName | undefined,
          to,
        }),
      );
      process.exit(code);
    }
    if (subverb === 'status') {
      const code = await runUnderJsonMode(
        { command: 'deploy status', active: json },
        () => runDeployStatus({
          configPath: config,
          adapterOverride: adapterArg as AdapterName | undefined,
        }),
      );
      process.exit(code);
    }
    if (subverb !== undefined) {
      console.error(
        `\x1b[31m[claude-autopilot] unknown deploy subverb "${subverb}" — valid: rollback, status\x1b[0m`,
      );
      process.exit(1);
    }
    const ref = flag('ref');
    const commitSha = flag('sha');
    const watch = boolFlag('watch');
    const prRaw = flag('pr');
    let prNum: number | undefined;
    if (prRaw !== undefined) {
      const n = parseInt(prRaw, 10);
      if (Number.isNaN(n) || n <= 0) {
        console.error(
          `\x1b[31m[claude-autopilot] --pr must be a positive integer, got "${prRaw}"\x1b[0m`,
        );
        process.exit(1);
      }
      prNum = n;
    }
    const code = await runUnderJsonMode(
      { command: 'deploy', active: json },
      () => runDeploy({
        configPath: config,
        adapterOverride: adapterArg as AdapterName | undefined,
        ref,
        commitSha,
        watch,
        pr: prNum,
      }),
    );
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
    const json = boolFlag('json');
    if (json) {
      // --json mode: surface the resume hint via nextActions, not a banner.
      const code = await runUnderJsonMode(
        {
          command: 'brainstorm',
          active: true,
          payload: () => ({
            note: 'brainstorm is a Claude Code skill, not a CLI subcommand',
            nextActions: [
              'Invoke /brainstorm from Claude Code for interactive spec writing',
              'Then /autopilot to run the full pipeline from an approved spec',
            ],
          }),
        },
        async () => 0,
      );
      process.exit(code);
    }
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

  case 'runs': {
    // v6 Phase 3 — umbrella verb. Sub-verbs: list, show, gc, delete, doctor.
    const sub = args[1];
    const json = boolFlag('json');
    const cwd = process.cwd();
    if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
      const focused = (await import('./help-text.ts')).buildCommandHelpText('runs');
      process.stdout.write(focused ?? buildHelpText());
      process.exit(0);
    }
    const {
      runRunsList,
      runRunsShow,
      runRunsGc,
      runRunsDelete,
      runRunsDoctor,
    } = await import('./runs.ts');
    let result;
    switch (sub) {
      case 'list': {
        result = await runRunsList({ cwd, status: flag('status'), json });
        break;
      }
      case 'show': {
        const events = boolFlag('events');
        const tailRaw = flag('events-tail');
        const eventsTail = tailRaw ? parseInt(tailRaw, 10) : undefined;
        // Filter out value-flag *values* — without this, `runs show
        // --events-tail 5 <ULID>` would resolve runId to '5'. Same pattern
        // as the scan case above. Caught by Cursor Bugbot on PR #88
        // (MEDIUM).
        const runId = args.slice(2).find(a =>
          !a.startsWith('--') && a !== tailRaw,
        );
        result = await runRunsShow({
          runId: runId ?? '',
          cwd,
          events,
          ...(eventsTail !== undefined ? { eventsTail } : {}),
          json,
        });
        break;
      }
      case 'gc': {
        const dryRun = boolFlag('dry-run');
        const yes = boolFlag('yes');
        const olderRaw = flag('older-than-days');
        const olderThanDays = olderRaw ? parseInt(olderRaw, 10) : undefined;
        result = await runRunsGc({
          cwd,
          dryRun,
          yes,
          ...(olderThanDays !== undefined ? { olderThanDays } : {}),
          json,
        });
        break;
      }
      case 'delete': {
        const runId = args.slice(2).find(a => !a.startsWith('--'));
        const force = boolFlag('force');
        result = await runRunsDelete({ runId: runId ?? '', cwd, force, json });
        break;
      }
      case 'doctor': {
        const runId = args.slice(2).find(a => !a.startsWith('--'));
        const fix = boolFlag('fix');
        result = await runRunsDoctor({
          cwd,
          ...(runId ? { runId } : {}),
          fix,
          json,
        });
        break;
      }
      default: {
        process.stderr.write(`\x1b[31m[claude-autopilot] runs: unknown sub-verb "${sub}" — valid: list, show, gc, delete, doctor\x1b[0m\n`);
        process.exit(1);
      }
    }
    for (const line of result.stdout) process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
    for (const line of result.stderr) process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
    process.exit(result.exit);
    break;
  }

  case 'run-resume': {
    // v6 Phase 3 — `run resume <id>`. Lookup-only: identifies the next phase
    // and decision rationale. Actual phase execution wires in Phase 6+.
    // The synthetic 'run-resume' subcommand was set above by the
    // disambiguation block; args[0]==='run', args[1]==='resume', args[2] is
    // optional run id.
    const json = boolFlag('json');
    const fromPhase = flag('from-phase') ?? flag('from');
    // Filter value-flag values out of positional lookup — see same comment
    // in the `runs show` case above. (Bugbot MEDIUM, PR #88.)
    const runId = args.slice(2).find(a =>
      !a.startsWith('--') && a !== fromPhase,
    );
    const { runRunResume } = await import('./runs.ts');
    const result = await runRunResume({
      runId: runId ?? '',
      cwd: process.cwd(),
      ...(fromPhase ? { fromPhase } : {}),
      json,
    });
    for (const line of result.stdout) process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
    for (const line of result.stderr) process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
    process.exit(result.exit);
    break;
  }

  case 'internal': {
    // v6 Phase 2 — hidden verb. Markdown skills shell out to append typed
    // events into a run's events.ndjson. NOT advertised in the main help.
    const { runInternalCli } = await import('../core/run-state/cli-internal.ts');
    const result = await runInternalCli({
      args: args.slice(1),
      cwd: process.cwd(),
    });
    for (const line of result.stdout) process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
    for (const line of result.stderr) process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
    process.exit(result.exit);
    break;
  }

  default:
    console.error(`\x1b[31m[claude-autopilot] Unknown subcommand: "${subcommand}"\x1b[0m`);
    printUsage();
    process.exit(1);
}
