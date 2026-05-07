import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from '../core/config/loader.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { type RunPhase } from '../core/run-state/phase-runner.ts';
import { runPhaseWithLifecycle } from '../core/run-state/run-phase-with-lifecycle.ts';

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
 *
 * Exported so the v6.2.0 orchestrator's phase registry can carry the typed
 * I/O shape on its `PhaseRegistration<PlanInput, PlanOutput>` slot.
 */
export interface PlanInput {
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
export interface PlanOutput {
  /** Absolute path to the written plan markdown file. */
  planFilePath: string;
  /** Whether the planner had a spec to consume. */
  specProvided: boolean;
  /** Echoed for the render layer / future skip-already-applied. */
  specPath: string | null;
}

/** v6.2.0 — see scan.ts for the kind='early-exit' rationale. Plan has no
 *  early-exit branches today; the discriminant is included for shape parity
 *  with the other builders. */
export interface BuildPlanPhaseEarlyExit {
  kind: 'early-exit';
  exitCode: number;
}

export interface BuildPlanPhaseResult {
  kind: 'phase';
  phase: RunPhase<PlanInput, PlanOutput>;
  input: PlanInput;
  config: GuardrailConfig;
  renderResult: (output: PlanOutput) => number;
}

/**
 * v6.2.0 — extract the `RunPhase<PlanInput, PlanOutput>` construction out of
 * `runPlan(options)` so the new top-level `autopilot` orchestrator can drive
 * `runPhase` itself with a shared `phaseIdx` against the same run dir.
 *
 * Parity asserted by `tests/cli/plan-builder-parity.test.ts`.
 */
export async function buildPlanPhase(
  options: PlanCommandOptions,
): Promise<BuildPlanPhaseResult | BuildPlanPhaseEarlyExit> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

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

  return {
    kind: 'phase',
    phase,
    input: planInput,
    config,
    renderResult: (output: PlanOutput) => renderPlanOutput(output, planInput),
  };
}

export async function runPlan(options: PlanCommandOptions = {}): Promise<number> {
  const built = await buildPlanPhase(options);
  if (built.kind === 'early-exit') return built.exitCode;

  const { phase, input, config, renderResult } = built;

  // v6.0.6 — lifecycle wiring lives in `runPhaseWithLifecycle`.
  let output: PlanOutput;
  try {
    const result = await runPhaseWithLifecycle<PlanInput, PlanOutput>({
      cwd: input.cwd,
      phase,
      input,
      config,
      cliEngine: options.cliEngine,
      envEngine: options.envEngine,
      runEngineOff: () => executePlanPhase(input),
    });
    output = result.output;
  } catch {
    return 1;
  }

  return renderResult(output);
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

  // Track whether the referenced spec file exists so the stub can record
  // a "(file not found)" annotation when the user pointed at a missing
  // path. We don't need to read the content — the planning content itself
  // is owned by the Claude Code skill, not the engine-wrap shell.
  // (Bugbot LOW PR #98: prior version did `readFileSync` whose result
  // was unused — only its nullness was checked.)
  const specExists = !!(specPath && fs.existsSync(specPath));

  // Ensure output directory exists, then write the plan-file stub.
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const lines = [
    '# Plan',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    specPath
      ? `Spec: ${specPath}${specExists ? '' : ' (file not found)'}`
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
