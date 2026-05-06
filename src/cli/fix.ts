import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execSync } from 'node:child_process';
import { loadCachedFindings } from '../core/persist/findings-cache.ts';
import { loadConfig } from '../core/config/loader.ts';
import { loadAdapter } from '../adapters/loader.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import type { Finding } from '../core/findings/types.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { generateFix, buildUnifiedDiff } from '../core/fix/generator.ts';
import { resolveEngineEnabled, type ResolveEngineResult } from '../core/run-state/resolve-engine.ts';
import { createRun } from '../core/run-state/runs.ts';
import { runPhase, type RunPhase } from '../core/run-state/phase-runner.ts';
import { appendEvent, replayState } from '../core/run-state/events.ts';
import { writeStateSnapshot } from '../core/run-state/state.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface FixCommandOptions {
  cwd?: string;
  configPath?: string;
  severity?: 'critical' | 'warning' | 'all';
  dryRun?: boolean;
  yes?: boolean;      // skip per-fix confirmation prompts
  noVerify?: boolean; // skip test verification after applying fix
  /**
   * v6.0.2 — engine knob inputs. Same shape and precedence as scan / costs
   * (CLI > env > config > built-in default off in v6.0.x). The CLI
   * dispatcher wires `cliEngine` from `--engine` / `--no-engine`;
   * `envEngine` from `process.env.CLAUDE_AUTOPILOT_ENGINE`. An absent CLI
   * flag + absent env value falls through to the loaded config and then to
   * the built-in default.
   */
  cliEngine?: boolean;
  envEngine?: string;
  /**
   * Test-only seam — injects a pre-built ReviewEngine so tests can exercise
   * the engine-wrap path without hitting `loadAdapter()` (and therefore
   * without needing an LLM API key in the environment). Mirrors the seam
   * in `scan.ts`. Production callers MUST NOT pass this.
   */
  __testReviewEngine?: ReviewEngine;
}

interface FixResult {
  file: string;
  line: number;
  findingMessage: string;
  status: 'fixed' | 'skipped' | 'rejected' | 'failed';
  reason?: string;
}

/**
 * Phase input — the prepared apply-loop context. Captured as a struct so
 * the engine path's phase body matches the engine-off path call signature.
 * Resolved by the outer scope (cached findings → filtered to fixable;
 * config → engine adapter; CLI flags → mode toggles).
 */
interface FixInput {
  cwd: string;
  fixable: Finding[];
  engine: ReviewEngine;
  testCommand: string | null;
  shouldVerify: boolean;
  dryRun: boolean;
  yes: boolean;
}

/**
 * Phase output — JSON-serializable summary suitable for persistence as
 * `result` on phases/fix.json. Mirrors what the legacy summary line
 * computes from `results`. Re-rendering from this output (e.g. a future
 * skip-already-applied) restores the same exit-code decision without
 * re-applying patches.
 */
interface FixOutput {
  results: FixResult[];
  /** Echoed so the legacy summary block can render the dry-run banner. */
  dryRun: boolean;
}

async function confirmFix(diff: string, finding: Finding): Promise<'yes' | 'no' | 'quit'> {
  console.log('');
  console.log(diff);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(fmt('bold', '  Apply this fix? [y]es / [n]o / [q]uit  '), answer => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === 'q') resolve('quit');
      else if (a === 'y' || a === '') resolve('yes');
      else resolve('no');
    });
  });
}

export async function runFix(options: FixCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');
  const severityFilter = options.severity ?? 'critical';

  const findings = loadCachedFindings(cwd);
  if (findings.length === 0) {
    console.log(fmt('yellow', '[fix] No cached findings — run `guardrail scan <path>` or `guardrail run` first.'));
    return 0;
  }

  // Two gates:
  //  - "actionable": has a real file path. Surfaced in dry-run so the user sees
  //    findings even when the LLM didn't pin a line number.
  //  - "fixable": also has a line. The LLM-fix loop needs both to extract a
  //    code snippet around the finding location.
  const actionable = findings.filter(f => {
    if (!f.file || f.file === '<unspecified>' || f.file === '<pipeline>') return false;
    if (severityFilter === 'all') return true;
    if (severityFilter === 'critical') return f.severity === 'critical';
    return f.severity === 'critical' || f.severity === 'warning';
  });
  const fixable = actionable.filter(f => f.line && f.line > 0);

  if (actionable.length === 0) {
    console.log(fmt('yellow', `[fix] No actionable findings (severity=${severityFilter}, need file path).`));
    return 0;
  }
  if (fixable.length === 0) {
    const verb = actionable.length === 1 ? 'has' : 'have';
    const noun = actionable.length === 1 ? 'finding' : 'findings';
    console.log(fmt('yellow', `[fix] ${actionable.length} ${noun} ${verb} file but no line — model output was line-less. Re-run scan with --ask "include line numbers" or run \`claude-autopilot run\` for richer extraction.`));
    for (const f of actionable) {
      const sev = f.severity === 'critical' ? fmt('red', 'CRITICAL')
        : f.severity === 'warning' ? fmt('yellow', 'WARNING ')
        : fmt('dim', 'NOTE    ');
      console.log(`  [${sev}] ${fmt('dim', f.file)} ${f.message}`);
    }
    return 0;
  }

  const modeNote = options.dryRun ? ' (dry run)' : options.yes ? '' : ' (interactive — use --yes to skip prompts)';
  console.log(`\n${fmt('bold', '[fix]')} ${fixable.length} finding${fixable.length !== 1 ? 's' : ''} to attempt${modeNote}\n`);

  // Print upfront summary of all fixable findings before prompting
  for (const f of fixable) {
    const sev = f.severity === 'critical' ? fmt('red', 'CRITICAL') : fmt('yellow', 'WARNING ');
    const loc = fmt('dim', `${f.file}:${f.line}`);
    console.log(`  [${sev}] ${loc} ${f.message}`);
    if (f.suggestion) console.log(fmt('dim', `           → ${f.suggestion}`));
  }
  console.log('');

  // Dry-run: listing the findings is sufficient — no LLM needed
  if (options.dryRun) {
    console.log(fmt('yellow', `[fix] Dry run — ${fixable.length} finding${fixable.length !== 1 ? 's' : ''} listed above, no files modified.\n`));
    return 0;
  }

  // Load config + review engine (config optional — defaults to auto adapter)
  let engine: ReviewEngine;
  let loadedConfig: GuardrailConfig | null = null;
  try {
    loadedConfig = fs.existsSync(configPath) ? await loadConfig(configPath) : null;
    if (options.__testReviewEngine) {
      // Test-only fast path — skip the adapter loader (and therefore the
      // implicit LLM key check inside the auto-loader). Same seam as scan's
      // `__testReviewEngine`. Production callers do not pass this.
      engine = options.__testReviewEngine;
    } else {
      const ref = loadedConfig
        ? (typeof loadedConfig.reviewEngine === 'string' ? loadedConfig.reviewEngine : (loadedConfig.reviewEngine?.adapter ?? 'auto'))
        : 'auto';
      engine = await loadAdapter<ReviewEngine>({
        point: 'review-engine',
        ref,
        options: loadedConfig && typeof loadedConfig.reviewEngine === 'object' ? loadedConfig.reviewEngine.options : undefined,
      });
    }
  } catch (err) {
    console.error(fmt('red', `[fix] Could not load review engine: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  // v6.0.2 — engine resolution. CLI > env > config > default. Resolved
  // here (after config load + engine adapter load) so engine-on still
  // creates a run dir + emits lifecycle events even when the apply loop
  // produces zero diffs. Matches scan/costs's behavior of always producing a
  // run dir when `--engine` is requested.
  const engineResolved: ResolveEngineResult = resolveEngineEnabled({
    ...(options.cliEngine !== undefined ? { cliEngine: options.cliEngine } : {}),
    ...(options.envEngine !== undefined ? { envValue: options.envEngine } : {}),
    ...(typeof loadedConfig?.engine?.enabled === 'boolean' ? { configEnabled: loadedConfig.engine.enabled } : {}),
  });

  const testCommand = loadedConfig?.testCommand ?? null;
  const shouldVerify = !options.noVerify && !!testCommand;
  if (shouldVerify) {
    console.log(fmt('dim', `[fix] Verified mode — running "${testCommand}" after each fix\n`));
  }

  const fixInput: FixInput = {
    cwd,
    fixable,
    engine,
    testCommand,
    shouldVerify,
    // The early-return above already exits when options.dryRun is true, so
    // we're always entering the apply loop here with dryRun=false. Keep the
    // field on FixInput for shape parity (renderFixOutput consumes it) and
    // for future engine-resume scenarios where the snapshot is replayed.
    dryRun: false,
    yes: options.yes === true,
  };

  // The wrapped phase body — runs the apply loop with native readline +
  // per-finding console output INSIDE the phase body. The recipe doc says
  // "no console output" for phase bodies, but `fix` is fundamentally
  // interactive: the user must see each diff and approve it. Same precedent
  // as scan keeping its LLM call inside the phase body. Documented
  // deviation, intentional.
  const phase: RunPhase<FixInput, FixOutput> = {
    name: 'fix',
    // Same-input → same-output: the LLM fix generator is deterministic per
    // (finding, file content) pair, and applied diffs are exact text
    // replacements. Re-running against the same cached findings against an
    // unchanged tree produces the same results.
    idempotent: true,
    // Local file edits only — no remote / git push / PR creation in the
    // existing `fix` flow. Per the recipe table, "side effects" means
    // platform-side mutations (PR comments, git push, deploy). Local file
    // writes are inside the project tree and the engine treats them like
    // findings-cache writes (already overwrite-style).
    hasSideEffects: false,
    run: async input => executeFixPhase(input),
  };

  let output: FixOutput;
  if (engineResolved.enabled) {
    // v6.0.2 — wire fix through the Run State Engine. Same shape as
    // scan / costs: createRun → runPhase → run.complete + state.json
    // refresh + best-effort lock release in finally.
    const created = await createRun({
      cwd,
      phases: ['fix'],
      config: {
        engine: { enabled: true, source: engineResolved.source },
        ...(engineResolved.invalidEnvValue !== undefined
          ? { invalidEnvValue: engineResolved.invalidEnvValue }
          : {}),
      },
    });
    if (engineResolved.invalidEnvValue !== undefined) {
      // Surface the invalid env value as a typed warning so observers
      // (`runs show <id> --events`) can attribute the fallthrough.
      appendEvent(
        created.runDir,
        {
          event: 'run.warning',
          message: `invalid CLAUDE_AUTOPILOT_ENGINE=${JSON.stringify(engineResolved.invalidEnvValue)} ignored`,
          details: { resolution: engineResolved },
        },
        { writerId: created.lock.writerId, runId: created.runId },
      );
    }
    const runStartedAt = Date.now();
    try {
      output = await runPhase<FixInput, FixOutput>(phase, fixInput, {
        runDir: created.runDir,
        runId: created.runId,
        writerId: created.lock.writerId,
        phaseIdx: 0,
      });
      appendEvent(
        created.runDir,
        {
          event: 'run.complete',
          status: 'success',
          totalCostUSD: 0,
          durationMs: Date.now() - runStartedAt,
        },
        { writerId: created.lock.writerId, runId: created.runId },
      );
      writeStateSnapshot(created.runDir, replayState(created.runDir));
    } catch (err) {
      appendEvent(
        created.runDir,
        {
          event: 'run.complete',
          status: 'failed',
          totalCostUSD: 0,
          durationMs: Date.now() - runStartedAt,
        },
        { writerId: created.lock.writerId, runId: created.runId },
      );
      writeStateSnapshot(created.runDir, replayState(created.runDir));
      console.error(fmt('red', `[fix] engine: phase failed — ${err instanceof Error ? err.message : String(err)}`));
      console.error(fmt('dim', `  inspect: claude-autopilot runs show ${created.runId} --events`));
      await created.lock.release();
      return 1;
    } finally {
      await created.lock.release().catch(() => { /* ignore */ });
    }
  } else {
    // Engine off — legacy stateless path. Behavior is byte-for-byte
    // identical to v6.0.1 so existing CI / scripts are unaffected.
    output = await executeFixPhase(fixInput);
  }

  return renderFixOutput(output, fixInput);
}

// ---------------------------------------------------------------------------
// Phase body — drive the apply loop. INTENTIONAL DEVIATION from the recipe:
// the loop emits per-finding console output and prompts via readline. Pure
// side-effect-free phase bodies are the recipe default; interactive verbs
// like `fix` are an explicit exception (same precedent as scan's LLM call
// inside its phase body). The summary banner + exit code logic still lives
// in `renderFixOutput` so the engine path's idempotency isn't coupled to
// the final stdout shape.
// ---------------------------------------------------------------------------

async function executeFixPhase(input: FixInput): Promise<FixOutput> {
  const { cwd, fixable, engine, testCommand, shouldVerify, dryRun, yes } = input;

  const results: FixResult[] = [];
  let quit = false;

  for (const finding of fixable) {
    if (quit) {
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped', reason: 'user quit' });
      continue;
    }

    const sev = finding.severity === 'critical' ? fmt('red', 'CRITICAL') : fmt('yellow', 'WARNING');
    console.log(`\n  [${sev}] ${fmt('dim', `${finding.file}:${finding.line}`)} ${finding.message}`);

    const result = await generateFix(finding, engine, cwd);

    if (result.status === 'cannot_fix') {
      console.log(fmt('dim', `    → skipped: ${result.reason}`));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped', reason: result.reason });
      continue;
    }

    if (result.status === 'rejected') {
      console.log(fmt('yellow', `    → rejected: ${result.reason}`));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'rejected', reason: result.reason });
      continue;
    }

    if (result.status === 'error') {
      console.log(fmt('red', `    → error: ${result.reason}`));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'failed', reason: result.reason });
      continue;
    }

    // Show diff
    const diff = buildUnifiedDiff(result.originalLines!, result.replacementLines!, finding.file, result.startLine!);

    if (dryRun) {
      console.log('');
      console.log(diff);
      console.log(fmt('dim', '    (dry run — not applied)'));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped', reason: 'dry run' });
      continue;
    }

    // Interactive confirmation (unless --yes)
    if (!yes) {
      const answer = await confirmFix(diff, finding);
      if (answer === 'quit') {
        quit = true;
        results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped', reason: 'user quit' });
        continue;
      }
      if (answer === 'no') {
        results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped', reason: 'user declined' });
        continue;
      }
    } else {
      // --yes mode: still print the diff so there's a record
      console.log('');
      console.log(diff);
    }

    // Apply fix atomically
    try {
      const absPath = path.resolve(cwd, finding.file);
      const originalContent = fs.readFileSync(absPath, 'utf8');
      const allLines = originalContent.split('\n');
      const newLines = [
        ...allLines.slice(0, result.startLine! - 1),
        ...result.replacementLines!,
        ...allLines.slice(result.endLine!),
      ];
      const tmp = absPath + '.guardrail.tmp';
      fs.writeFileSync(tmp, newLines.join('\n'), 'utf8');
      fs.renameSync(tmp, absPath);

      if (shouldVerify) {
        // Verified mode — same shell invocation pattern as phases/tests.ts
        console.log(fmt('dim', `    ↻ verifying…`));
        const passed = runTestCommand(testCommand!, cwd);
        if (passed) {
          console.log(fmt('green', `    ✓ applied + tests pass`));
          results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'fixed' });
        } else {
          fs.writeFileSync(absPath, originalContent, 'utf8');
          console.log(fmt('yellow', `    ⚠ reverted — tests failed after fix`));
          results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'rejected', reason: 'tests failed after fix — reverted' });
        }
      } else {
        console.log(fmt('green', `    ✓ applied`));
        results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'fixed' });
      }
    } catch (err) {
      console.log(fmt('red', `    ✗ write failed: ${err instanceof Error ? err.message : String(err)}`));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'failed', reason: String(err) });
    }
  }

  return { results, dryRun };
}

// ---------------------------------------------------------------------------
// Render — translate FixOutput back to the legacy stdout summary + exit
// code. Lives outside the wrapped phase so the engine path's idempotency
// isn't coupled to the final summary line shape.
// ---------------------------------------------------------------------------

function renderFixOutput(output: FixOutput, input: FixInput): number {
  const { results, dryRun } = output;
  const { fixable } = input;

  const fixed    = results.filter(r => r.status === 'fixed').length;
  const rejected = results.filter(r => r.status === 'rejected').length;
  const failed   = results.filter(r => r.status === 'failed').length;
  const skipped  = results.filter(r => r.status === 'skipped').length;

  console.log('');
  if (dryRun) {
    console.log(fmt('yellow', `[fix] Dry run complete — ${fixable.length} finding${fixable.length !== 1 ? 's' : ''} previewed, no files modified.\n`));
  } else {
    const parts = [
      fixed   > 0 ? fmt('green',  `${fixed} fixed`)    : null,
      rejected > 0 ? fmt('yellow', `${rejected} rejected`) : null,
      failed  > 0 ? fmt('red',    `${failed} failed`)   : null,
      skipped > 0 ? fmt('dim',    `${skipped} skipped`)  : null,
    ].filter(Boolean).join(fmt('dim', ' · '));
    console.log(`[fix] ${parts}\n`);
  }

  return failed > 0 ? 1 : 0;
}

function runTestCommand(cmd: string, cwd: string): boolean {
  try {
    execSync(cmd, {
      cwd,
      stdio: 'ignore',
      timeout: 120000,
      shell: process.env.SHELL ?? '/bin/sh',
    });
    return true;
  } catch {
    return false;
  }
}

