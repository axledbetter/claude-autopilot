// src/cli/implement.ts
//
// v6.0.7 — wrap the `implement` pipeline phase through `runPhaseWithLifecycle`.
//
// `implement` is the implementation phase of the autopilot pipeline (brainstorm
// → spec → plan → implement → migrate → validate → pr → review). The actual
// implementation work — reading the plan, dispatching subagents one per plan
// phase via the `subagent-driven-development` skill, writing code, running
// tests, committing, optionally pushing — lives in Claude Code skills, not in
// this CLI verb. The CLI verb that ships in this binary is an engine-wrap
// shell: it writes a checkpointable phase log stub so v6 pipeline runs can
// record an `implement` phase entry alongside the rest. Mirrors the
// validate / review / plan dispatcher shape.
//
// Idempotency / side effects (deviation note vs. spec table):
//
// The v6 spec table at `docs/specs/v6-run-state-engine.md` (line 159) lists
// `implement` with `idempotent: partial, hasSideEffects: yes,
// externalRefs: git-remote-push`. That declaration assumes the verb itself
// writes commits and pushes them to a remote. The v6.0.7 wrap declares
// `idempotent: true, hasSideEffects: false` because the v6.0.7 CLI verb does
// **not** write code, run tests, commit, or push to a remote. All of that
// work lives in the Claude Code `claude-autopilot` skill (and its delegates:
// `subagent-driven-development`, `commit-push-pr`, `using-git-worktrees`).
// The CLI verb is the engine-wrap shell — its only side effect is writing
// the local `.guardrail-cache/implement/<ts>-implement.md` log stub, which
// the engine treats as overwrite-style (same precedent as
// `.guardrail-cache/validate/`, `.guardrail-cache/plans/`,
// `.guardrail-cache/reviews/`).
//
// If a future PR inlines the implement loop into the CLI verb (writes code,
// runs tests, commits, pushes), the declarations will flip to
// `idempotent: false, hasSideEffects: true` and the wrap will need to call
// `ctx.emitExternalRef({ kind: 'git-remote-push', id: '<commit-sha>',
// observedAt: ... })` after each successful push. The helper signature does
// not need to grow for that — `phase.run` already receives `ctx`, and the
// underlying `runPhase()` records externalRefs unchanged.

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

export interface ImplementCommandOptions {
  cwd?: string;
  configPath?: string;
  /**
   * Optional context note injected into the implement log. The actual
   * implementation work (reading the plan, dispatching subagents, writing
   * code, running tests, committing, optionally pushing) is owned by the
   * Claude Code `claude-autopilot` skill and its delegates
   * (`subagent-driven-development`, `commit-push-pr`,
   * `using-git-worktrees`); this CLI verb is the engine-wrap shell so v6
   * pipeline runs can checkpoint an `implement` phase entry alongside
   * `plan` / `migrate` / `validate` / `pr` / `review`.
   */
  context?: string;
  /**
   * Optional reference to the plan file the implement phase consumed
   * (e.g. `docs/plans/2026-05-05-foo.md`). Echoed into the log stub so
   * `runs show <id>` can surface it. The CLI verb does not read the plan
   * — it just records the path for downstream introspection.
   */
  plan?: string;
  /**
   * Where to write the implement log file. Defaults to
   * `.guardrail-cache/implement/<timestamp>-implement.md` so it lands inside
   * the cache that's already gitignored. The path is recorded on
   * ImplementOutput so the engine path can persist it as `result` for
   * replay.
   */
  outputPath?: string;
  /**
   * v6.0.7 — engine knob inputs. Same shape and precedence as scan / costs /
   * fix / plan / review / validate (CLI > env > config > built-in default
   * off in v6.0.x).
   */
  cliEngine?: boolean;
  envEngine?: string;
}

/**
 * Phase input — captured as a struct so the engine path's phase body matches
 * the engine-off path call signature.
 */
interface ImplementInput {
  cwd: string;
  context: string | null;
  plan: string | null;
  outputPath: string;
}

/**
 * Phase output — JSON-serializable summary suitable for persistence as
 * `result` on phases/implement.json. A future skip-already-applied (Phase 6)
 * could restore this without re-invoking the implement loop by reading the
 * persisted log path.
 */
interface ImplementOutput {
  /** Absolute path to the written implement log file. */
  implementLogPath: string;
  /** Echoed for the render layer / future skip-already-applied. */
  context: string | null;
  /** Plan file path the implement phase was pointed at, if any. */
  plan: string | null;
}

export async function runImplement(options: ImplementCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  // INTENTIONAL DEVIATION FROM THE SPEC TABLE (documented at top of file):
  // the v6 spec (`docs/specs/v6-run-state-engine.md`, line 159) lists
  // `implement` with `idempotent: partial, hasSideEffects: yes,
  // externalRefs: git-remote-push`. The v6.0.7 wrap declares
  // `idempotent: true, hasSideEffects: false` because the v6.0.7 CLI verb
  // is an engine-wrap shell — the actual code-writing / commit / push loop
  // lives in the Claude Code `claude-autopilot` skill, not in this CLI verb.
  // Local file write only — no git push, no PR creation, no provider-side
  // mutation. If a future PR inlines the implement loop into the CLI verb,
  // both declarations flip and a `ctx.emitExternalRef({ kind:
  // 'git-remote-push', id: '<commit-sha>' })` call lands after each push.
  const context = options.context ?? null;
  const plan = options.plan ?? null;
  const outputPath = options.outputPath
    ? path.resolve(cwd, options.outputPath)
    : path.join(cwd, '.guardrail-cache', 'implement', `${new Date().toISOString().replace(/[:.]/g, '-')}-implement.md`);

  const implementInput: ImplementInput = { cwd, context, plan, outputPath };

  // The wrapped phase body — writes an implement log stub to disk. The
  // actual implement loop (read plan → dispatch subagents → write code →
  // run tests → commit → optional push) is produced by the Claude Code
  // `claude-autopilot` skill and its delegates. Engine-off callers invoke
  // this directly via `executeImplementPhase()`; engine-on callers route
  // through `runPhase()`.
  const phase: RunPhase<ImplementInput, ImplementOutput> = {
    name: 'implement',
    // Re-running the implement verb against the same context + plan writes
    // the same log file. Engine treats local file writes as overwrite-style
    // — same precedent as scan's findings-cache and validate's validate-log.
    // Once the implement loop inlines into the CLI verb, this flips to
    // `false` per the spec table and the wrap will rely on the
    // `git-remote-push` externalRef readback for resume safety.
    idempotent: true,
    // Local file write only in v6.0.7 — no PR comment posting, no git push,
    // no provider-side mutation. See the long deviation note above where
    // `context`/`plan`/`outputPath` are computed for the externalRefs
    // rationale.
    hasSideEffects: false,
    run: async input => executeImplementPhase(input),
  };

  // v6.0.6+ — lifecycle wiring lives in `runPhaseWithLifecycle`. The helper
  // owns the engine-on/engine-off branch and the failure banner; the caller
  // just supplies the phase, the input, and the engine-off escape hatch.
  let output: ImplementOutput;
  try {
    const result = await runPhaseWithLifecycle<ImplementInput, ImplementOutput>({
      cwd,
      phase,
      input: implementInput,
      config,
      cliEngine: options.cliEngine,
      envEngine: options.envEngine,
      runEngineOff: () => executeImplementPhase(implementInput),
    });
    output = result.output;
  } catch {
    // Helper already printed the failure banner + emitted run.complete
    // failed + refreshed state.json + released the lock. Surface the
    // legacy non-zero exit so existing CI / scripts are unaffected.
    return 1;
  }

  return renderImplementOutput(output, implementInput);
}

// ---------------------------------------------------------------------------
// Phase body — write an implement log stub. Pure: no console output, no exit
// codes. Returns a JSON-serializable ImplementOutput so the engine can persist
// it as `result` on the phase snapshot. The actual implement loop is produced
// by the Claude Code `claude-autopilot` skill; this CLI verb's job is to
// provide a checkpointable phase shell.
// ---------------------------------------------------------------------------

async function executeImplementPhase(input: ImplementInput): Promise<ImplementOutput> {
  const { context, plan, outputPath } = input;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const lines = [
    '# Implement',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    context ? `Context: ${context}` : 'Context: (none provided)',
    plan ? `Plan: ${plan}` : 'Plan: (none provided)',
    '',
    '<!--',
    'This is the v6 engine-wrap stub for the `implement` phase. The actual',
    'implement loop (read plan → dispatch subagents one per plan phase via',
    'the `subagent-driven-development` skill → write code → run tests →',
    'commit on the branch → optionally push via `commit-push-pr`) is',
    'produced by the Claude Code `claude-autopilot` skill. The CLI verb',
    'exists to provide a checkpointable phase shell so',
    '`claude-autopilot runs show <id>` reflects an `implement` phase entry',
    'when the pipeline includes one.',
    '-->',
    '',
  ];
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');

  return {
    implementLogPath: outputPath,
    context,
    plan,
  };
}

// ---------------------------------------------------------------------------
// Render — translate ImplementOutput back to a stdout summary + exit code.
// Lives outside the wrapped phase because it's pure presentation.
// ---------------------------------------------------------------------------

function renderImplementOutput(output: ImplementOutput, input: ImplementInput): number {
  const { implementLogPath, context, plan } = output;
  const { cwd } = input;

  console.log('');
  console.log(fmt('bold', '[implement]') + ' ' + fmt('dim', context ? `context: ${context}` : 'no context provided'));
  if (plan) console.log(fmt('dim', `  plan: ${plan}`));
  console.log(fmt('dim', `  → ${path.relative(cwd, implementLogPath)}`));
  console.log('');
  console.log(fmt('cyan', 'Note:') + fmt('dim', ' the implement loop lives in Claude Code (`claude-autopilot` skill —'));
  console.log(fmt('dim', '       reads plan, dispatches subagents per plan phase, writes code, runs'));
  console.log(fmt('dim', '       tests, commits, optionally pushes via `commit-push-pr`).'));
  console.log('');
  return 0;
}
