// src/cli/spec.ts
//
// v6.0.3 — wrap the `spec` pipeline phase through `runPhase`.
//
// `spec` is the second phase of the autopilot pipeline (brainstorm → spec →
// plan → implement → migrate → validate → pr → review). Like `brainstorm`, it
// is implemented primarily as a Claude Code skill, not as a standalone CLI
// subcommand. The CLI verb that ships in this binary is an advisory shim: it
// points the user at the Claude Code skill and the next pipeline verbs. There
// is no LLM call in the CLI verb body and no provider side effects. The
// pure-LLM spec writing happens in Claude Code; the spec markdown produced
// there lands at `docs/superpowers/specs/<slug>.md` (a local file write —
// the recipe treats local file writes as acceptable inside the phase body,
// identical precedent to `fix.ts` editing local source files).
//
// Idempotency / side effects (deviation note vs. spec table):
//   - The spec table at docs/specs/v6-run-state-engine.md says
//     `idempotent: no` for `spec` because re-running produces NEW LLM
//     content each invocation. v6.0.3 declares `idempotent: true` to match
//     the engine's actual semantics ("safe to retry without
//     reconciliation"): the CLI verb itself is a printed advisory that is
//     byte-for-byte identical on every invocation, has no externalRefs to
//     reconcile, and no provider state to roll back. Same reasoning as the
//     brainstorm wrap. See `src/cli/brainstorm.ts` for the longer
//     deviation rationale.
//   - `hasSideEffects: false` — the CLI verb prints to stdout. No provider
//     calls, no git push, no PR creation, no remote API write.

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
  cyan: '\x1b[36m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface SpecCommandOptions {
  cwd?: string;
  configPath?: string;
  /**
   * v6.0.3 — engine knob inputs. Same shape and precedence as scan / costs /
   * fix / brainstorm (CLI > env > config > built-in default off in v6.0.x).
   */
  cliEngine?: boolean;
  envEngine?: string;
  /**
   * Test-only seam — when true, the phase body returns its result without
   * printing the advisory banner. Lets engine-smoke tests assert the
   * `state.json` + `events.ndjson` lifecycle without polluting stdout.
   * Production callers (the CLI dispatcher) MUST NOT pass this.
   */
  __silent?: boolean;
}

/**
 * Phase input — minimal. The CLI verb body is a print-and-exit advisory.
 * Captured as a struct so the engine path's phase body matches the
 * engine-off path call signature.
 */
interface SpecInput {
  cwd: string;
  silent: boolean;
}

/**
 * Phase output — JSON-serializable acknowledgment. Mirrors the shape of
 * `BrainstormOutput`. Persisted as `result` on `phases/spec.json`.
 */
interface SpecOutput {
  /** Always 'advisory' for v6.0.3 — the CLI verb is a Claude Code pointer. */
  kind: 'advisory';
  nextActions: string[];
}

export async function runSpec(options: SpecCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  const engineResolved: ResolveEngineResult = resolveEngineEnabled({
    ...(options.cliEngine !== undefined ? { cliEngine: options.cliEngine } : {}),
    ...(options.envEngine !== undefined ? { envValue: options.envEngine } : {}),
    ...(typeof config.engine?.enabled === 'boolean' ? { configEnabled: config.engine.enabled } : {}),
  });

  const specInput: SpecInput = { cwd, silent: options.__silent === true };

  const phase: RunPhase<SpecInput, SpecOutput> = {
    name: 'spec',
    // Pure-LLM spec writing happens in the Claude Code skill, not here.
    // The CLI verb is an advisory print with no externalRefs to reconcile
    // and no provider state to roll back. Safe to retry. (Deviation from
    // the spec table noted at the top of the file.)
    idempotent: true,
    // No provider calls, no git push, no PR creation. Identical to costs
    // and brainstorm.
    hasSideEffects: false,
    run: async input => executeSpecPhase(input),
  };

  let output: SpecOutput;
  if (engineResolved.enabled) {
    const created = await createRun({
      cwd,
      phases: ['spec'],
      config: {
        engine: { enabled: true, source: engineResolved.source },
        ...(engineResolved.invalidEnvValue !== undefined
          ? { invalidEnvValue: engineResolved.invalidEnvValue }
          : {}),
      },
    });
    if (engineResolved.invalidEnvValue !== undefined) {
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
      output = await runPhase<SpecInput, SpecOutput>(phase, specInput, {
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
      console.error(fmt('red', `[spec] engine: phase failed — ${err instanceof Error ? err.message : String(err)}`));
      console.error(fmt('dim', `  inspect: claude-autopilot runs show ${created.runId} --events`));
      await created.lock.release();
      return 1;
    } finally {
      await created.lock.release().catch(() => { /* ignore */ });
    }
  } else {
    output = await executeSpecPhase(specInput);
  }

  return renderSpecOutput(output, specInput);
}

// ---------------------------------------------------------------------------
// Phase body — produce the advisory payload. Pure: no provider calls.
// ---------------------------------------------------------------------------

async function executeSpecPhase(_input: SpecInput): Promise<SpecOutput> {
  return {
    kind: 'advisory',
    nextActions: [
      'Approve a brainstorm output, then invoke /autopilot from Claude Code',
      'The autopilot skill writes the implementation plan + executes the pipeline',
    ],
  };
}

// ---------------------------------------------------------------------------
// Render — translate SpecOutput back to the stdout advisory + exit code.
// ---------------------------------------------------------------------------

function renderSpecOutput(_output: SpecOutput, input: SpecInput): number {
  if (input.silent) return 0;
  console.log(`
${fmt('bold', '[spec]')} Spec writing is a Claude Code skill, not a standalone CLI subcommand.

Invoke it from Claude Code:

  ${fmt('cyan', '/brainstorm')}                         Interactive spec writing (entry point)
  ${fmt('cyan', '/autopilot')}                          Full pipeline from an approved spec
  ${fmt('cyan', '/migrate')}                            Database migration phase (stack-dependent)

Specs land at ${fmt('dim', 'docs/superpowers/specs/<slug>.md')} — once approved, /autopilot consumes them.

Full pipeline docs: https://github.com/axledbetter/claude-autopilot#the-pipeline-phase-by-phase
`);
  return 0;
}
