// src/cli/brainstorm.ts
//
// v6.0.3 — wrap the `brainstorm` pipeline phase through `runPhase`.
//
// `brainstorm` is the entry point of the autopilot pipeline. It is implemented
// primarily as a Claude Code skill (`/brainstorm` → `superpowers:brainstorming`),
// not as a standalone CLI subcommand. The CLI verb that ships in this binary is
// an advisory shim: it points the user at the Claude Code skill and the next
// pipeline verbs. There is no LLM call in the CLI verb body, and no provider
// side effects. The pure-LLM design dialogue happens in Claude Code; the spec
// markdown produced there lands at `docs/superpowers/specs/<slug>.md` (a local
// file write, not a platform-side-effect-free remote write — the recipe treats
// local file writes as acceptable inside the phase body, identical precedent to
// `fix.ts` editing local source files).
//
// Idempotency / side effects (deviation note vs. spec table):
//   - The spec table at docs/specs/v6-run-state-engine.md says
//     `idempotent: no` for `brainstorm` because re-running produces NEW LLM
//     content each invocation. The recipe table at
//     docs/v6/wrapping-pipeline-phases.md previously echoed that. v6.0.3
//     declares `idempotent: true` to match the engine's actual semantics
//     ("safe to retry without reconciliation"): the CLI verb itself is a
//     printed advisory message that is byte-for-byte identical on every
//     invocation, has no externalRefs to reconcile, and no provider state
//     to roll back. The engine's idempotency check is "safe to replay,"
//     not "produces byte-identical output." See the recipe section 2:
//     `idempotent: true → phase output depends only on its input + project
//     state, and re-running gives the same answer.` That holds here.
//   - `hasSideEffects: false` — the CLI verb prints to stdout. No provider
//     calls, no git push, no PR creation, no remote API write. Identical
//     to costs.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from '../core/config/loader.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { type RunPhase } from '../core/run-state/phase-runner.ts';
import { runPhaseWithLifecycle } from '../core/run-state/run-phase-with-lifecycle.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface BrainstormCommandOptions {
  cwd?: string;
  configPath?: string;
  /**
   * v6.0.3 — engine knob inputs. Same shape and precedence as scan / costs /
   * fix (CLI > env > config > built-in default off in v6.0.x). The CLI
   * dispatcher wires `cliEngine` from `--engine` / `--no-engine`;
   * `envEngine` from `process.env.CLAUDE_AUTOPILOT_ENGINE`. An absent CLI
   * flag + absent env value falls through to the loaded config and then to
   * the built-in default.
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
interface BrainstormInput {
  cwd: string;
  silent: boolean;
}

/**
 * Phase output — JSON-serializable acknowledgment. Mirrors the shape of
 * other read-only verbs' outputs. Persisted as `result` on
 * `phases/brainstorm.json`. A future skip-already-applied (Phase 6) could
 * restore this without re-running.
 */
interface BrainstormOutput {
  /** Always 'advisory' for v6.0.3 — the CLI verb is a Claude Code pointer. */
  kind: 'advisory';
  /**
   * Suggested next actions surfaced to the user (also rendered in --json
   * mode by the dispatcher's `nextActions` payload).
   */
  nextActions: string[];
}

export async function runBrainstorm(options: BrainstormCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  const brainstormInput: BrainstormInput = { cwd, silent: options.__silent === true };

  // The wrapped phase body. Pure: reads no files, makes no provider calls.
  // Engine-off callers invoke `executeBrainstormPhase()` directly;
  // engine-on callers route through `runPhase()`.
  const phase: RunPhase<BrainstormInput, BrainstormOutput> = {
    name: 'brainstorm',
    // Pure-LLM design dialogue happens in the Claude Code skill, not here.
    // The CLI verb is an advisory print with no externalRefs to reconcile
    // and no provider state to roll back. Safe to retry. (Deviation from
    // the spec table noted at the top of the file.)
    idempotent: true,
    // No provider calls, no git push, no PR creation. Identical to costs.
    hasSideEffects: false,
    run: async input => executeBrainstormPhase(input),
  };

  // v6.0.6 — lifecycle wiring lives in `runPhaseWithLifecycle`. The helper
  // owns the engine-on/engine-off branch and the failure banner.
  let output: BrainstormOutput;
  try {
    const result = await runPhaseWithLifecycle<BrainstormInput, BrainstormOutput>({
      cwd,
      phase,
      input: brainstormInput,
      config,
      cliEngine: options.cliEngine,
      envEngine: options.envEngine,
      runEngineOff: () => executeBrainstormPhase(brainstormInput),
    });
    output = result.output;
  } catch {
    // Helper already printed the failure banner + emitted run.complete
    // failed + refreshed state.json + released the lock.
    return 1;
  }

  return renderBrainstormOutput(output, brainstormInput);
}

// ---------------------------------------------------------------------------
// Phase body — produce the advisory payload. Pure: no provider calls. By
// default does NOT print to stdout (the renderer handles that) so the engine
// path's idempotency isn't coupled to console output. Returns a
// JSON-serializable BrainstormOutput so the engine can persist it as
// `result` on the phase snapshot.
// ---------------------------------------------------------------------------

async function executeBrainstormPhase(_input: BrainstormInput): Promise<BrainstormOutput> {
  return {
    kind: 'advisory',
    nextActions: [
      'Invoke /brainstorm from Claude Code for interactive spec writing',
      'Then /autopilot to run the full pipeline from an approved spec',
    ],
  };
}

// ---------------------------------------------------------------------------
// Render — translate BrainstormOutput back to the legacy stdout advisory +
// exit code. Lives outside the wrapped phase because it's pure presentation;
// doing the rendering inside the phase would couple the engine path's
// idempotency to console output.
// ---------------------------------------------------------------------------

function renderBrainstormOutput(_output: BrainstormOutput, input: BrainstormInput): number {
  if (input.silent) return 0;
  console.log(`
${fmt('bold', '[brainstorm]')} The pipeline entry point is a Claude Code skill, not a CLI subcommand.

Invoke it from Claude Code:

  ${fmt('cyan', '/brainstorm')}                         Interactive spec writing
  ${fmt('cyan', '/autopilot')}                          Full pipeline from an approved spec
  ${fmt('cyan', '/migrate')}                            Database migration phase (stack-dependent)

From the terminal, the CLI subset exposes only the individual review-phase subcommands:

  ${fmt('cyan', 'claude-autopilot run --base main')}    Just the review phase
  ${fmt('cyan', 'claude-autopilot doctor')}             Check prerequisites (incl. superpowers plugin)
  ${fmt('cyan', 'claude-autopilot migrate-v4')}         Codemod for v4 → v5 repo migration (not a pipeline phase)

Full pipeline docs: https://github.com/axledbetter/claude-autopilot#the-pipeline-phase-by-phase
`);
  return 0;
}
