// src/cli/autopilot.ts
//
// v6.2.0 — multi-phase orchestrator. Drives N pipeline phases under ONE
// runId so a `runs watch <id>` window covers the whole pipeline (vs the
// pre-v6.2 chain where every CLI verb owned its own runId).
//
// Lifecycle (per spec docs/specs/v6.2-multi-phase-orchestrator.md):
//
//   createRun({ phases: [allPhaseNames] })
//   for each phase in phases:
//     buildPhase(deps) → { phase: RunPhase<I,O>, input: I, renderResult }
//     runPhase(phase, input, { runDir, runId, writerId, phaseIdx, budget })
//     catch failure → record + exit
//   emit run.complete (success | failed) ONCE
//   refresh state.json snapshot
//   release lock in finally
//
// What this verb deliberately does NOT do (out-of-scope for v6.2.0):
//   - migrate / pr (v6.2.1, gated on per-phase idempotency contracts)
//   - --mode=fix / --mode=review (v6.2.1+)
//   - --json envelope (v6.2.2)
//   - parallel phases (reserved indefinitely — pipelines are sequential)
//   - interactive prompts (the verb is non-interactive by design)
//
// Engine-on REQUIRED: the orchestrator throws `invalid_config` exit 1 if
// the user explicitly disables the engine (`--no-engine`,
// `CLAUDE_AUTOPILOT_ENGINE=off|false|0|no`, or `engine.enabled: false` in
// config). v6.1 made engine-on the default; orchestrator runs cannot exist
// without a run dir so the opt-out is rejected here at pre-flight.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from '../core/config/loader.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { GuardrailError } from '../core/errors.ts';
import {
  PHASE_REGISTRY,
  DEFAULT_FULL_PHASES,
  validatePhaseNames,
  type PhaseName,
} from '../core/run-state/phase-registry.ts';
import { createRun } from '../core/run-state/runs.ts';
import { runPhase } from '../core/run-state/phase-runner.ts';
import { appendEvent, replayState } from '../core/run-state/events.ts';
import { writeStateSnapshot } from '../core/run-state/state.ts';
import {
  resolveEngineEnabled,
  type ResolveEngineResult,
} from '../core/run-state/resolve-engine.ts';
import type { BudgetConfig } from '../core/run-state/budget.ts';

// ---------------------------------------------------------------------------
// ANSI codes — kept inline to match the rest of cli/ (no shared formatter).
// ---------------------------------------------------------------------------

const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_DIM = '\x1b[2m';
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_CYAN = '\x1b[36m';
const fmt = (color: string, text: string): string => `${color}${text}${ANSI_RESET}`;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type AutopilotMode = 'full';
// v6.2.1+ will add 'fix' and 'review' once their per-phase idempotency
// contracts land. Kept narrow on purpose — invalid mode strings are a
// pre-run validation failure (exit 1, invalid_config).

export interface AutopilotOptions {
  cwd?: string;
  configPath?: string;
  /** Pipeline mode. v6.2.0 supports `'full'` only (scan → spec → plan →
   *  implement). Defaults to `'full'` when neither `mode` nor `phases`
   *  is supplied. */
  mode?: AutopilotMode;
  /** Explicit phase list (overrides `mode`). Validated against
   *  PHASE_REGISTRY before any run dir is created — unknown names exit 1
   *  with `invalid_config`. */
  phases?: readonly string[];
  /** Run-scope budget (USD). When set, every phase passes through the
   *  shared `BudgetConfig` with `scope: 'run'` so `actualSoFar` accumulates
   *  across phases. */
  budgetUSD?: number;
  /** v6.0.x — engine knob. The orchestrator REJECTS engine-off explicitly
   *  (per spec "Engine-off"); these fields exist so the dispatcher can pass
   *  them through and the orchestrator can produce a clear error message. */
  cliEngine?: boolean;
  envEngine?: string;
  /** Test seam — keep stdout banners suppressed. Production callers MUST
   *  NOT pass this; the dispatcher does not surface a flag for it. */
  __silent?: boolean;
}

export interface AutopilotPhaseSummary {
  name: string;
  status: 'success' | 'failed' | 'skipped' | 'not-run';
  errorCode?: string;
  errorMessage?: string;
  costUSD: number;
  durationMs: number;
}

export interface AutopilotResult {
  runId: string | null;
  runDir: string | null;
  exitCode: number;
  errorCode?: string;
  errorMessage?: string;
  phases: AutopilotPhaseSummary[];
  totalCostUSD: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// runAutopilot — entry point
// ---------------------------------------------------------------------------

export async function runAutopilot(options: AutopilotOptions = {}): Promise<AutopilotResult> {
  const cwd = options.cwd ?? process.cwd();
  const silent = options.__silent === true;
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  const startedAt = Date.now();

  // --- Pre-flight 1: load config -----------------------------------------
  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  // --- Pre-flight 2: engine-on REQUIRED (per spec) -----------------------
  // The orchestrator cannot operate without a run dir; engine-off is
  // rejected here before any side effects.
  const engineResolved: ResolveEngineResult = resolveEngineEnabled({
    ...(options.cliEngine !== undefined ? { cliEngine: options.cliEngine } : {}),
    ...(options.envEngine !== undefined ? { envValue: options.envEngine } : {}),
    ...(typeof config.engine?.enabled === 'boolean'
      ? { configEnabled: config.engine.enabled }
      : {}),
  });
  if (!engineResolved.enabled) {
    if (!silent) {
      process.stderr.write(
        fmt(
          ANSI_RED,
          `[autopilot] invalid_config: orchestrator requires the v6 engine but it's disabled (${engineResolved.reason})\n`,
        ),
      );
      process.stderr.write(
        fmt(
          ANSI_DIM,
          `  hint: drop --no-engine, unset CLAUDE_AUTOPILOT_ENGINE=off, or set engine.enabled: true in guardrail.config.yaml\n`,
        ),
      );
    }
    return {
      runId: null,
      runDir: null,
      exitCode: 1,
      errorCode: 'invalid_config',
      errorMessage: `orchestrator requires engine-on (${engineResolved.reason})`,
      phases: [],
      totalCostUSD: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  // --- Pre-flight 3: resolve phase list ----------------------------------
  let phaseNames: readonly string[];
  if (options.phases && options.phases.length > 0) {
    phaseNames = options.phases;
  } else {
    const mode: AutopilotMode = options.mode ?? 'full';
    if (mode === 'full') {
      phaseNames = DEFAULT_FULL_PHASES;
    } else {
      // Unreachable today (the type only allows 'full'), but kept for
      // forward-compat — `--mode=fix|review` lands in v6.2.1+.
      if (!silent) {
        process.stderr.write(
          fmt(ANSI_RED, `[autopilot] invalid_config: unknown mode "${mode as string}"\n`),
        );
      }
      return {
        runId: null,
        runDir: null,
        exitCode: 1,
        errorCode: 'invalid_config',
        errorMessage: `unknown mode "${mode as string}"`,
        phases: [],
        totalCostUSD: 0,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  const validation = validatePhaseNames(phaseNames);
  if (!validation.ok) {
    if (!silent) {
      process.stderr.write(
        fmt(
          ANSI_RED,
          `[autopilot] invalid_config: unknown phase(s): ${validation.unknown.join(', ')}\n`,
        ),
      );
      process.stderr.write(
        fmt(
          ANSI_DIM,
          `  registered: ${Object.keys(PHASE_REGISTRY).join(', ')}\n`,
        ),
      );
    }
    return {
      runId: null,
      runDir: null,
      exitCode: 1,
      errorCode: 'invalid_config',
      errorMessage: `unknown phase(s): ${validation.unknown.join(', ')}`,
      phases: [],
      totalCostUSD: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  // --- Build the BudgetConfig (run-scope) --------------------------------
  // v6.2.0 — when --budget is passed, every phase gets the same
  // `BudgetConfig` with `scope: 'run'` so the cap accumulates across
  // phases. Per spec WARNING #2 (codex review).
  const budget: BudgetConfig | undefined = options.budgetUSD !== undefined
    ? { perRunUSD: options.budgetUSD, scope: 'run' }
    : undefined;

  // --- Create the run ----------------------------------------------------
  // ONE run dir, ONE runId, phases laid out at creation time so each
  // `runPhase` call uses the matching phaseIdx.
  const created = await createRun({
    cwd,
    phases: [...phaseNames],
    config: {
      engine: { enabled: true, source: engineResolved.source },
      mode: options.mode ?? (options.phases ? 'phases' : 'full'),
      ...(options.budgetUSD !== undefined ? { budgetUSD: options.budgetUSD } : {}),
    },
  });

  if (!silent) {
    const budgetSuffix = options.budgetUSD !== undefined ? `  budget=$${options.budgetUSD.toFixed(2)}` : '';
    process.stdout.write(
      fmt(ANSI_BOLD, `[autopilot]`) + ` runId=${created.runId}${budgetSuffix}\n`,
    );
  }

  const phaseSummaries: AutopilotPhaseSummary[] = phaseNames.map(name => ({
    name,
    status: 'not-run' as const,
    costUSD: 0,
    durationMs: 0,
  }));

  // --- Run each phase ---------------------------------------------------
  let failedAtPhase: number | null = null;
  let failedPhaseName: string | null = null;
  let phaseErrorCode: string | undefined;
  let phaseErrorMessage: string | undefined;

  try {
    for (let phaseIdx = 0; phaseIdx < phaseNames.length; phaseIdx++) {
      const name = phaseNames[phaseIdx]! as PhaseName;
      const entry = PHASE_REGISTRY[name];

      if (!silent) {
        process.stdout.write(
          fmt(ANSI_BOLD, `[autopilot]`) +
            ` phase ${phaseIdx + 1}/${phaseNames.length}: ${name}\n`,
        );
      }

      const phaseStartedAt = Date.now();
      // Each builder takes its own option shape; v6.2.0's registered phases
      // all accept an empty `{}` because the orchestrator runs them with
      // their default option values (cwd is inherited via process.cwd()
      // → builder default). Per-phase options arrive in v6.2.1+ via the
      // `--phase-args` JSON envelope; v6.2.0 keeps the orchestrator
      // simple-by-design.
      // Pass cwd explicitly so the registered builders create their phase
      // input pointed at the orchestrator's run dir, not whatever the
      // process happened to launch from. Each builder's command-options
      // type accepts `cwd` (see scan.ts / spec.ts / plan.ts / implement.ts).
      // The `as never` is unavoidable here: PHASE_REGISTRY's keys are
      // heterogeneous and the type system can't narrow `entry.build` to a
      // single signature when `name` is the literal union. Each registered
      // builder accepts `{ cwd }` so the runtime call is correct.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const built = await (entry.build as (opts: { cwd: string }) => Promise<any>)({
        cwd,
      });

      if (built.kind === 'early-exit') {
        // A phase pre-flight bailed before producing a RunPhase. We treat
        // a non-zero early-exit as a phase failure (the verb decided it
        // can't proceed); 0 means "nothing to do" and we record skipped
        // and continue. Today's registered phases never produce a
        // non-zero early-exit on the orchestrator's `{ cwd }` shape, but
        // we honor the contract for forward-compat.
        if (built.exitCode === 0) {
          phaseSummaries[phaseIdx] = {
            name,
            status: 'skipped',
            costUSD: 0,
            durationMs: Date.now() - phaseStartedAt,
          };
          continue;
        }
        failedAtPhase = phaseIdx;
        failedPhaseName = name;
        phaseErrorCode = 'invalid_config';
        phaseErrorMessage = `phase "${name}" pre-flight refused (exit ${built.exitCode})`;
        phaseSummaries[phaseIdx] = {
          name,
          status: 'failed',
          errorCode: 'invalid_config',
          errorMessage: phaseErrorMessage,
          costUSD: 0,
          durationMs: Date.now() - phaseStartedAt,
        };
        break;
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const output: any = await runPhase(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          built.phase as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          built.input as any,
          {
            runDir: created.runDir,
            runId: created.runId,
            writerId: created.lock.writerId,
            phaseIdx,
            ...(budget !== undefined ? { budget } : {}),
            // The orchestrator runs non-interactively by design — a pause
            // decision becomes hard-fail so CI / scripts don't deadlock.
            nonInteractive: true,
          },
        );

        const durationMs = Date.now() - phaseStartedAt;
        const costUSD = extractCostUSD(output);
        phaseSummaries[phaseIdx] = {
          name,
          status: 'success',
          costUSD,
          durationMs,
        };

        // Translate output back to the verb's legacy banner. We swallow
        // the per-phase exit code on success — the orchestrator's overall
        // exit is determined by the run, not by individual phase
        // renderResult return values (which are always 0 on success for
        // the four registered v6.2.0 phases).
        if (!silent) {
          built.renderResult(output);
        }
      } catch (err) {
        const durationMs = Date.now() - phaseStartedAt;
        const message = err instanceof Error ? err.message : String(err);
        const errorCode = err instanceof GuardrailError ? err.code : undefined;
        failedAtPhase = phaseIdx;
        failedPhaseName = name;
        phaseErrorCode = errorCode ?? 'phase_failed';
        phaseErrorMessage = message;
        phaseSummaries[phaseIdx] = {
          name,
          status: 'failed',
          ...(errorCode !== undefined ? { errorCode } : {}),
          errorMessage: message,
          costUSD: 0,
          durationMs,
        };
        if (!silent) {
          process.stderr.write(
            fmt(
              ANSI_RED,
              `[autopilot] phase ${phaseIdx + 1}/${phaseNames.length} (${name}) failed: ${message}\n`,
            ),
          );
        }
        break;
      }
    }

    // --- Emit run.complete + refresh state ------------------------------
    const totalCostUSD = phaseSummaries.reduce((acc, p) => acc + p.costUSD, 0);
    const overallDurationMs = Date.now() - startedAt;
    const overallStatus = failedAtPhase === null ? 'success' : 'failed';

    appendEvent(
      created.runDir,
      {
        event: 'run.complete',
        status: overallStatus,
        totalCostUSD,
        durationMs: overallDurationMs,
      },
      { writerId: created.lock.writerId, runId: created.runId },
    );
    writeStateSnapshot(created.runDir, replayState(created.runDir));

    // --- Compute exit code (per spec exit-code matrix) ------------------
    const exitCode = computeExitCode({ failedAtPhase, phaseErrorCode });

    if (!silent) {
      if (overallStatus === 'success') {
        process.stdout.write(
          fmt(ANSI_GREEN, `[autopilot] run complete`) +
            ` ${formatDuration(overallDurationMs)} ` +
            fmt(ANSI_DIM, `· $${totalCostUSD.toFixed(4)}`) +
            '\n',
        );
        process.stdout.write(
          fmt(ANSI_DIM, `  inspect: claude-autopilot runs show ${created.runId} --events\n`),
        );
      } else {
        process.stdout.write(
          fmt(
            ANSI_RED,
            `[autopilot] failed at phase ${(failedAtPhase ?? 0) + 1}/${phaseNames.length} (${failedPhaseName})\n`,
          ),
        );
        process.stdout.write(
          fmt(ANSI_DIM, `  inspect: claude-autopilot runs show ${created.runId} --events\n`),
        );
        process.stdout.write(
          fmt(ANSI_DIM, `  resume:  claude-autopilot run resume ${created.runId}\n`),
        );
      }
    }

    return {
      runId: created.runId,
      runDir: created.runDir,
      exitCode,
      ...(phaseErrorCode !== undefined ? { errorCode: phaseErrorCode } : {}),
      ...(phaseErrorMessage !== undefined ? { errorMessage: phaseErrorMessage } : {}),
      phases: phaseSummaries,
      totalCostUSD,
      durationMs: overallDurationMs,
    };
  } finally {
    await created.lock.release().catch(() => { /* best effort */ });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ComputeExitOpts {
  failedAtPhase: number | null;
  phaseErrorCode: string | undefined;
}

/** v6.2.0 — exit-code matrix from spec "Failure semantics + exit codes":
 *
 *    | Failure source                                         | Exit code |
 *    |--------------------------------------------------------|-----------|
 *    | All phases succeed                                     | 0         |
 *    | Phase failure where errorCode === 'budget_exceeded'    | 78        |
 *    | Phase failure where errorCode in {lock_held,           | 2         |
 *    |   corrupted_state, partial_write}                      |           |
 *    | Any other phase failure                                | 1         |
 *
 *  Pre-run validation failures (engine-off, unknown phase, etc.) exit 1
 *  with `errorCode: 'invalid_config'` BEFORE this helper is reached. */
function computeExitCode(opts: ComputeExitOpts): number {
  if (opts.failedAtPhase === null) return 0;
  switch (opts.phaseErrorCode) {
    case 'budget_exceeded':
      return 78;
    case 'lock_held':
    case 'corrupted_state':
    case 'partial_write':
      return 2;
    default:
      return 1;
  }
}

/** Extract `costUSD` from a phase output if present, else 0. Same shape
 *  as the legacy `runPhaseWithLifecycle` helper — only `scan` exposes one
 *  today; the other three v6.2.0 phases are read-only and return 0. */
function extractCostUSD(output: unknown): number {
  if (output !== null && typeof output === 'object' && 'costUSD' in output) {
    const v = (output as { costUSD?: unknown }).costUSD;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

// Re-export so the dispatcher can mention it in --help without importing
// from the registry separately. (Pure convenience; no behavioral effect.)
export { PHASE_REGISTRY, DEFAULT_FULL_PHASES };
export type { PhaseName };
