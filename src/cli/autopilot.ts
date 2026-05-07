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
import {
  resumePreflight,
  type ResumeDecision,
} from '../core/run-state/resume-preflight.ts';
import type { ExternalRef, RunEvent } from '../core/run-state/types.ts';
import {
  AUTOPILOT_ERROR_CODES,
  computeAutopilotExitCode,
  writeAutopilotEnvelope,
  __isAutopilotEnvelopeWritten,
  type AutopilotErrorCode,
  type AutopilotJsonResult,
  type AutopilotPhaseResult,
} from './json-envelope.ts';

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

      // v6.2.1 — resume preflight for side-effecting phases. Reads any
      // prior phase.success + persisted externalRefs out of events.ndjson
      // and routes per the spec decision matrix BEFORE invoking runPhase.
      // For a fresh run (no prior events for this phaseIdx) the preflight
      // returns `proceed-fresh` and the orchestrator falls through to the
      // normal phase invocation below. For a resumed run, the matrix can
      // short-circuit to skip-already-applied or escalate to needs-human.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const phaseRunPhase = built.phase as { hasSideEffects?: boolean };
      if (phaseRunPhase.hasSideEffects === true) {
        const preEffect = entry.preEffectRefKinds ?? [];
        const postEffect = entry.postEffectRefKinds ?? [];
        const prior = collectPriorPhaseState(created.runDir, name, phaseIdx);
        const decision = await resumePreflight({
          preEffectRefKinds: preEffect as readonly string[],
          postEffectRefKinds: postEffect as readonly string[],
          priorPhaseSuccess: prior.priorPhaseSuccess,
          priorRefs: prior.priorRefs,
        });
        const handled = await applyResumeDecision({
          decision,
          runDir: created.runDir,
          runId: created.runId,
          writerId: created.lock.writerId,
          phaseName: name,
          phaseIdx,
          phaseStartedAt,
          phaseSummaries,
        });
        if (handled === 'skipped') continue;
        if (handled === 'failed') {
          failedAtPhase = phaseIdx;
          failedPhaseName = name;
          phaseErrorCode = 'needs_human';
          phaseErrorMessage = decision.kind === 'needs-human'
            ? `resume preflight refused (${decision.reason})`
            : 'resume preflight refused';
          break;
        }
        // 'proceed' — fall through to the normal runPhase invocation.
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

// ---------------------------------------------------------------------------
// v6.2.1 — resume preflight helpers
// ---------------------------------------------------------------------------

interface PriorPhaseState {
  priorPhaseSuccess: boolean;
  priorRefs: ExternalRef[];
}

/** Read events.ndjson and pull out:
 *   - whether a prior `phase.success` exists for this phaseIdx
 *   - all `phase.externalRef` events recorded for this phaseIdx
 *
 *  Used by the orchestrator's resume preflight to decide skip / retry /
 *  needs-human. For a fresh run the events file has only `run.start` (and
 *  possibly `phase.start` if we're mid-phase) → both fields come back
 *  empty/false and the preflight returns `proceed-fresh`. */
function collectPriorPhaseState(
  runDir: string,
  phaseName: string,
  phaseIdx: number,
): PriorPhaseState {
  const eventsPath = path.join(runDir, 'events.ndjson');
  if (!fs.existsSync(eventsPath)) {
    return { priorPhaseSuccess: false, priorRefs: [] };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch {
    return { priorPhaseSuccess: false, priorRefs: [] };
  }
  const lines = raw.split('\n').filter(line => line.length > 0);
  let priorPhaseSuccess = false;
  const priorRefs: ExternalRef[] = [];
  for (const line of lines) {
    let ev: RunEvent;
    try {
      ev = JSON.parse(line) as RunEvent;
    } catch {
      continue;
    }
    if (ev.event === 'phase.success' && ev.phaseIdx === phaseIdx && ev.phase === phaseName) {
      priorPhaseSuccess = true;
    } else if (
      ev.event === 'phase.externalRef' &&
      ev.phaseIdx === phaseIdx &&
      ev.phase === phaseName
    ) {
      priorRefs.push(ev.ref);
    }
  }
  return { priorPhaseSuccess, priorRefs };
}

interface ApplyResumeDecisionInput {
  decision: ResumeDecision;
  runDir: string;
  runId: string;
  writerId: { pid: number; hostHash: string };
  phaseName: string;
  phaseIdx: number;
  phaseStartedAt: number;
  phaseSummaries: AutopilotPhaseSummary[];
}

/** Carry out the resume decision's side effects on the durable log + phase
 *  summaries. Returns:
 *    - `skipped`  → orchestrator continues to phase N+1
 *    - `failed`   → orchestrator records phase failure and breaks the loop
 *    - `proceed`  → orchestrator falls through to runPhase normally
 *
 *  For `skip-already-applied` we emit a synthetic `phase.success` event
 *  with empty artifacts so downstream tooling (`runs show`) sees the
 *  phase as completed. The event carries `replayed: true` via the meta
 *  channel — except `phase.success` doesn't have a meta slot in the
 *  schema, so the replay flag is conveyed exclusively via the
 *  `replay.override`-class events; the success event itself is
 *  indistinguishable from a fresh success. That matches the spec's intent
 *  ("emit phase.success { replayed: true, reason: 'side-effect-already-
 *  applied' }") modulo schema constraints — the readback's metadata is
 *  preserved on the next event we DO write. */
async function applyResumeDecision(
  input: ApplyResumeDecisionInput,
): Promise<'skipped' | 'failed' | 'proceed'> {
  const { decision, runDir, runId, writerId, phaseName, phaseIdx, phaseStartedAt, phaseSummaries } = input;

  if (decision.kind === 'proceed-fresh') return 'proceed';
  if (decision.kind === 'retry') return 'proceed';

  if (decision.kind === 'skip-already-applied') {
    const durationMs = Date.now() - phaseStartedAt;
    appendEvent(
      runDir,
      {
        event: 'phase.success',
        phase: phaseName,
        phaseIdx,
        durationMs,
        artifacts: [],
      },
      { writerId, runId },
    );
    phaseSummaries[phaseIdx] = {
      name: phaseName,
      status: 'success',
      costUSD: 0,
      durationMs,
    };
    return 'skipped';
  }

  // needs-human — emit replay.override with the consulted refs, then bail.
  appendEvent(
    runDir,
    {
      event: 'replay.override',
      phase: phaseName,
      phaseIdx,
      reason: decision.reason,
      refsConsulted: decision.refsConsulted,
    },
    { writerId, runId },
  );
  appendEvent(
    runDir,
    {
      event: 'phase.needs-human',
      phase: phaseName,
      phaseIdx,
      reason: decision.reason,
      nextActions: [
        '--force-replay to bypass the preflight after manual ledger inspection',
        `claude-autopilot runs show ${runId} --events`,
      ],
    },
    { writerId, runId },
  );
  const durationMs = Date.now() - phaseStartedAt;
  phaseSummaries[phaseIdx] = {
    name: phaseName,
    status: 'failed',
    errorCode: 'needs_human',
    errorMessage: `resume preflight refused (${decision.reason})`,
    costUSD: 0,
    durationMs,
  };
  return 'failed';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

// ===========================================================================
// v6.2.2 — `claude-autopilot autopilot --json` envelope
//
// `runAutopilotWithJsonEnvelope` is the entrypoint the dispatcher uses when
// `--json` is passed. It wraps `runAutopilot`, captures the per-phase
// outcomes into the spec's `AutopilotPhaseResult[]` shape, and emits exactly
// one envelope on stdout via `writeAutopilotEnvelope`.
//
// The single-write latch + process-scoped uncaughtException/unhandledRejection
// handlers (codex WARNING #2) live here. Tests pass
// `__testInstallProcessHandlers: false` to avoid leaking the handlers into
// the rest of the suite — production callers always get `true` (the default).
// ===========================================================================

export interface AutopilotJsonOptions extends AutopilotOptions {
  /** Test seam — install process-level uncaughtException / unhandledRejection
   *  handlers that emit a fallback envelope if the orchestrator throws past
   *  our try/catch. Default: true (production behavior). Tests pass false to
   *  avoid leaking handlers across the suite. */
  __testInstallProcessHandlers?: boolean;
  /** Test seam — when set, the orchestrator throws AFTER the success
   *  envelope is written. Used to verify the single-write latch suppresses
   *  the uncaughtException handler's fallback envelope. Production code
   *  never sets this. */
  __testThrowAfterEnvelope?: () => never;
}

interface InstalledProcessHandlers {
  uncaughtException: (err: unknown) => void;
  unhandledRejection: (err: unknown) => void;
}

/** Install process-scoped fatal handlers for `--json` mode. Returns a
 *  removal function so the caller (test seam) can detach them deterministically.
 *
 *  Both handlers consult the single-write latch via
 *  `__isAutopilotEnvelopeWritten()` — if an envelope already shipped, they
 *  no-op-exit; otherwise they emit a fallback `internal_error` envelope and
 *  exit 1. Per spec "Channel discipline" → "Exactly-once guarantee under
 *  fatal paths". */
function installAutopilotJsonProcessHandlers(
  startedAt: number,
): { remove: () => void; handlers: InstalledProcessHandlers } {
  const handlers: InstalledProcessHandlers = {
    uncaughtException: (err: unknown) => {
      if (__isAutopilotEnvelopeWritten()) {
        process.exit(1);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      writeAutopilotEnvelope({
        runId: null,
        status: 'failed',
        exitCode: 1,
        phases: [],
        totalCostUSD: 0,
        durationMs: Date.now() - startedAt,
        errorCode: 'internal_error',
        errorMessage: message,
      });
      // Best-effort flush before exit.
      process.stdout.write('', () => process.exit(1));
    },
    unhandledRejection: (err: unknown) => {
      if (__isAutopilotEnvelopeWritten()) {
        process.exit(1);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      writeAutopilotEnvelope({
        runId: null,
        status: 'failed',
        exitCode: 1,
        phases: [],
        totalCostUSD: 0,
        durationMs: Date.now() - startedAt,
        errorCode: 'internal_error',
        errorMessage: message,
      });
      process.stdout.write('', () => process.exit(1));
    },
  };
  process.on('uncaughtException', handlers.uncaughtException);
  process.on('unhandledRejection', handlers.unhandledRejection);
  return {
    handlers,
    remove: () => {
      process.removeListener('uncaughtException', handlers.uncaughtException);
      process.removeListener('unhandledRejection', handlers.unhandledRejection);
    },
  };
}

/** Translate the orchestrator's internal phase summary status into the
 *  envelope's bounded enum. Pre-run failures and unstarted phases are
 *  reported as `failed`; replay short-circuits map to `skipped-replay`. */
function toEnvelopePhaseStatus(
  status: AutopilotPhaseSummary['status'],
): AutopilotPhaseResult['status'] {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
    case 'not-run':
      return 'failed';
    case 'skipped':
      return 'skipped-replay';
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return 'failed';
    }
  }
}

/** Map an internal `AutopilotResult.errorCode` (string, possibly
 *  unrecognized) onto the bounded `AutopilotErrorCode` enum. Unknown
 *  values fall back to `phase_failed` so CI consumers always get a
 *  member of the published enum. */
function narrowErrorCode(
  code: string | undefined,
): AutopilotErrorCode | undefined {
  if (code === undefined) return undefined;
  if ((AUTOPILOT_ERROR_CODES as readonly string[]).includes(code)) {
    return code as AutopilotErrorCode;
  }
  return 'phase_failed';
}

/** Build the envelope's `AutopilotJsonResult` from the orchestrator's
 *  internal `AutopilotResult`. Pure projection — no IO. */
function resultToJsonResult(result: AutopilotResult): AutopilotJsonResult {
  const failedIdx = result.phases.findIndex(p => p.status === 'failed');
  const errorCode = narrowErrorCode(result.errorCode);
  const status: 'success' | 'failed' = result.exitCode === 0 ? 'success' : 'failed';
  const phases: AutopilotPhaseResult[] = result.phases.map(p => ({
    name: p.name,
    status: toEnvelopePhaseStatus(p.status),
    costUSD: p.costUSD,
    durationMs: p.durationMs,
  }));
  const exitCode = computeAutopilotExitCode(errorCode);
  // Defensive: if narrowErrorCode mapped us off the canonical exit code (e.g.
  // an internal `errorCode: 'concurrency_lock'` → fallback `phase_failed`)
  // prefer the orchestrator's authoritative `exitCode` so we don't disagree
  // with the legacy text-mode path. The mapping above is the canonical
  // translation; this is the safety belt.
  const finalExitCode: 0 | 1 | 2 | 78 = (() => {
    if (status === 'success') return 0;
    if (errorCode !== undefined) return exitCode;
    // Fall back to whatever the orchestrator returned, clamped to the
    // documented set.
    const ec = result.exitCode;
    if (ec === 0 || ec === 1 || ec === 2 || ec === 78) return ec;
    return 1;
  })();
  const out: AutopilotJsonResult = {
    runId: result.runId,
    status,
    exitCode: finalExitCode,
    phases,
    totalCostUSD: result.totalCostUSD,
    durationMs: result.durationMs,
  };
  if (errorCode !== undefined) out.errorCode = errorCode;
  if (result.errorMessage !== undefined) out.errorMessage = result.errorMessage;
  if (failedIdx >= 0) {
    out.failedAtPhase = failedIdx;
    out.failedPhaseName = result.phases[failedIdx]!.name;
  }
  return out;
}

/** v6.2.2 entrypoint for `claude-autopilot autopilot --json`.
 *
 *  Wraps `runAutopilot` (which already handles pre-run failures inline by
 *  returning an `AutopilotResult` with `runId: null` + populated
 *  `errorCode` / `errorMessage`) and emits exactly one envelope on stdout.
 *  Process-level fatal handlers (codex WARNING #2) catch async failures
 *  that would otherwise bypass our try/catch.
 *
 *  Returns the exit code the dispatcher should propagate via
 *  `process.exit`. */
export async function runAutopilotWithJsonEnvelope(
  options: AutopilotJsonOptions = {},
): Promise<number> {
  const startedAt = Date.now();
  const installHandlers = options.__testInstallProcessHandlers !== false; // default true
  const handlerHandle = installHandlers
    ? installAutopilotJsonProcessHandlers(startedAt)
    : null;

  // Force `__silent` so the orchestrator's own banner stdout writes don't
  // pollute the envelope. Per spec "Channel discipline" — stdout in --json
  // mode is the envelope and ONLY the envelope.
  const innerOptions: AutopilotOptions = {
    ...options,
    __silent: true,
  };

  let exitCode: 0 | 1 | 2 | 78 = 1;
  try {
    let result: AutopilotResult;
    try {
      result = await runAutopilot(innerOptions);
    } catch (err) {
      // Orchestrator threw past its own try/catch — surface as
      // internal_error envelope. Non-GuardrailError throws here are usually
      // bugs; we still emit a deterministic envelope so CI sees something
      // parseable.
      const message = err instanceof Error ? err.message : String(err);
      const errorCode: AutopilotErrorCode =
        err instanceof GuardrailError &&
        (AUTOPILOT_ERROR_CODES as readonly string[]).includes(err.code)
          ? (err.code as AutopilotErrorCode)
          : 'internal_error';
      const ec = computeAutopilotExitCode(errorCode);
      writeAutopilotEnvelope({
        runId: null,
        status: 'failed',
        exitCode: ec,
        phases: [],
        totalCostUSD: 0,
        durationMs: Date.now() - startedAt,
        errorCode,
        errorMessage: message,
      });
      await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
      exitCode = ec;
      return exitCode;
    }

    const jsonResult = resultToJsonResult(result);
    writeAutopilotEnvelope(jsonResult);
    await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
    exitCode = jsonResult.exitCode;

    // Test seam — emulate a finalization throw AFTER the envelope is on
    // disk so the latch test can verify uncaughtException handlers no-op.
    if (typeof options.__testThrowAfterEnvelope === 'function') {
      options.__testThrowAfterEnvelope();
    }

    return exitCode;
  } finally {
    if (handlerHandle) handlerHandle.remove();
  }
}

// Re-export so the dispatcher can mention it in --help without importing
// from the registry separately. (Pure convenience; no behavioral effect.)
export { PHASE_REGISTRY, DEFAULT_FULL_PHASES };
export type { PhaseName };
