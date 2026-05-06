import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from '../core/config/loader.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { resolveEngineEnabled, type ResolveEngineResult } from '../core/run-state/resolve-engine.ts';
import { createRun } from '../core/run-state/runs.ts';
import { runPhase, type RunPhase } from '../core/run-state/phase-runner.ts';
import { appendEvent, replayState } from '../core/run-state/events.ts';
import { writeStateSnapshot } from '../core/run-state/state.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface PlanCommandOptions {
  cwd?: string;
  configPath?: string;
  /**
   * Path to a spec file the planner should read. Optional — when absent, the
   * phase falls back to "no spec provided" and just records that fact in the
   * plan-file output. The actual LLM-driven planning lives in the Claude Code
   * superpowers:writing-plans skill; this CLI verb is the engine-wrap shell so
   * v6 pipeline runs can checkpoint a `plan` phase even when the planner
   * itself is invoked from inside Claude Code.
   */
  specPath?: string;
  /**
   * Where to write the plan markdown file. Defaults to
   * `.guardrail-cache/plans/<timestamp>-plan.md` so it lands inside the
   * cache that's already gitignored. The path is recorded on PlanOutput so
   * the engine path can persist it as `result` for replay.
   */
  outputPath?: string;
  /**
   * v6.0.4 — engine knob inputs. Same shape and precedence as scan / costs /
   * fix (CLI > env > config > built-in default off in v6.0.x). The CLI
   * dispatcher wires `cliEngine` from `--engine` / `--no-engine`;
   * `envEngine` from `process.env.CLAUDE_AUTOPILOT_ENGINE`.
   */
  cliEngine?: boolean;
  envEngine?: string;
}

/**
 * Phase input — captured as a struct so the engine path's phase body matches
 * the engine-off path call signature. Resolved by the outer scope (config,
 * spec path, output path).
 */
interface PlanInput {
  cwd: string;
  specPath: string | null;
  outputPath: string;
}

/**
 * Phase output — JSON-serializable summary suitable for persistence as
 * `result` on phases/plan.json. Mirrors what the legacy summary line
 * computes. A future skip-already-applied (Phase 6) could restore this
 * without re-running the planner by reading the persisted plan-file path.
 */
interface PlanOutput {
  /** Absolute path to the written plan markdown file. */
  planFilePath: string;
  /** Whether the planner had a spec to consume. */
  specProvided: boolean;
  /** Echoed for the render layer / future skip-already-applied. */
  specPath: string | null;
}

export async function runPlan(options: PlanCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  // v6.0.4 — engine resolution. CLI > env > config > default. Resolved
  // BEFORE the planner runs so engine-on still creates a run dir + emits
  // lifecycle events even when no spec is provided. Matches scan / costs /
  // fix behavior of always producing a run dir when `--engine` is requested.
  const engineResolved: ResolveEngineResult = resolveEngineEnabled({
    ...(options.cliEngine !== undefined ? { cliEngine: options.cliEngine } : {}),
    ...(options.envEngine !== undefined ? { envValue: options.envEngine } : {}),
    ...(typeof config.engine?.enabled === 'boolean' ? { configEnabled: config.engine.enabled } : {}),
  });

  // Resolve spec path (optional) and output path. Default output lives under
  // .guardrail-cache/plans/ so it's gitignored alongside other cache state.
  const specPath = options.specPath ? path.resolve(cwd, options.specPath) : null;
  const outputPath = options.outputPath
    ? path.resolve(cwd, options.outputPath)
    : path.join(cwd, '.guardrail-cache', 'plans', `${new Date().toISOString().replace(/[:.]/g, '-')}-plan.md`);

  const planInput: PlanInput = {
    cwd,
    specPath,
    outputPath,
  };

  // The wrapped phase body — writes a plan markdown stub to disk. The actual
  // LLM-driven planning lives in the Claude Code superpowers:writing-plans
  // skill; this CLI verb is the engine-wrap shell so pipeline runs can
  // checkpoint a `plan` phase deterministically. Engine-off callers invoke
  // this directly via `executePlanPhase()`; engine-on callers route through
  // `runPhase()`.
  const phase: RunPhase<PlanInput, PlanOutput> = {
    name: 'plan',
    // Re-running the planner against the same spec writes the same plan
    // file. The engine treats local file writes as overwrite-style — same
    // precedent as scan's findings-cache. Re-running is safe and cheap.
    idempotent: true,
    // Local file write only — no provider calls, no PR comment, no git
    // push. Per the recipe table, "side effects" means platform-side
    // mutations. The plan file lives under .guardrail-cache/plans/ which
    // is gitignored.
    hasSideEffects: false,
    run: async input => executePlanPhase(input),
  };

  let output: PlanOutput;
  if (engineResolved.enabled) {
    // v6.0.4 — wire plan through the Run State Engine. Same shape as
    // scan / costs / fix: createRun → runPhase → run.complete + state.json
    // refresh + best-effort lock release in finally.
    const created = await createRun({
      cwd,
      phases: ['plan'],
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
      output = await runPhase<PlanInput, PlanOutput>(phase, planInput, {
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
      console.error(fmt('red', `[plan] engine: phase failed — ${err instanceof Error ? err.message : String(err)}`));
      console.error(fmt('dim', `  inspect: claude-autopilot runs show ${created.runId} --events`));
      await created.lock.release();
      return 1;
    } finally {
      await created.lock.release().catch(() => { /* ignore */ });
    }
  } else {
    // Engine off — legacy stateless path. This is the v6.0.4 baseline; there
    // was no prior `plan` CLI verb in v6.0.3 (planning lived only as a
    // Claude Code skill). Calling this verb without --engine still writes
    // the plan-file stub so the same-input → same-output guarantee holds.
    output = await executePlanPhase(planInput);
  }

  return renderPlanOutput(output, planInput);
}

// ---------------------------------------------------------------------------
// Phase body — write a plan markdown stub. Pure: no console output, no exit
// codes. Returns a JSON-serializable PlanOutput so the engine can persist it
// as `result` on the phase snapshot. The actual LLM-driven planning content
// is produced by the Claude Code superpowers:writing-plans skill; this CLI
// verb's job is to provide a checkpointable phase shell.
// ---------------------------------------------------------------------------

async function executePlanPhase(input: PlanInput): Promise<PlanOutput> {
  const { specPath, outputPath } = input;

  // Read spec content if provided — allows the stub to record what spec
  // it was pointed at. The planning content itself is owned by the skill.
  let specContent: string | null = null;
  if (specPath && fs.existsSync(specPath)) {
    specContent = fs.readFileSync(specPath, 'utf8');
  }

  // Ensure output directory exists, then write the plan-file stub.
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const lines = [
    '# Plan',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    specPath
      ? `Spec: ${specPath}${specContent === null ? ' (file not found)' : ''}`
      : 'Spec: (none provided)',
    '',
    '<!--',
    'This is the v6 engine-wrap stub for the `plan` phase. The actual',
    'LLM-driven planning content is produced by the Claude Code',
    'superpowers:writing-plans skill. The CLI verb exists to provide a',
    'checkpointable phase shell so `claude-autopilot runs show <id>`',
    'reflects a `plan` phase entry when the pipeline includes one.',
    '-->',
    '',
  ];
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');

  return {
    planFilePath: outputPath,
    specProvided: specPath !== null,
    specPath,
  };
}

// ---------------------------------------------------------------------------
// Render — translate PlanOutput back to a stdout summary + exit code. Lives
// outside the wrapped phase because it's pure presentation; doing the
// rendering inside the phase would couple the engine path's idempotency to
// console output.
// ---------------------------------------------------------------------------

function renderPlanOutput(output: PlanOutput, input: PlanInput): number {
  const { planFilePath, specProvided, specPath } = output;
  const { cwd } = input;

  console.log('');
  console.log(fmt('bold', '[plan]') + ' ' + fmt('dim', specProvided ? `spec: ${specPath}` : 'no spec provided'));
  console.log(fmt('dim', `  → ${path.relative(cwd, planFilePath)}`));
  console.log('');
  console.log(fmt('cyan', 'Note:') + fmt('dim', ' the LLM-driven planner lives in Claude Code (superpowers:writing-plans skill).'));
  console.log(fmt('dim', '       This CLI verb provides the v6 engine-wrap checkpoint only.'));
  console.log('');
  return 0;
}
