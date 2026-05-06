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

export interface ReviewCommandOptions {
  cwd?: string;
  configPath?: string;
  /**
   * Optional context note injected into the review log. The actual review
   * content (LLM-driven code review against a PR diff or working tree) is
   * produced by the Claude Code review skills (`/review`, `/review-2pass`,
   * `pr-review-toolkit:review-pr`); this CLI verb is the engine-wrap shell
   * so v6 pipeline runs can checkpoint a `review` phase entry.
   */
  context?: string;
  /**
   * Where to write the review log file. Defaults to
   * `.guardrail-cache/reviews/<timestamp>-review.md` so it lands inside the
   * cache that's already gitignored. The path is recorded on ReviewOutput so
   * the engine path can persist it as `result` for replay.
   */
  outputPath?: string;
  /**
   * v6.0.4 — engine knob inputs. Same shape and precedence as scan / costs /
   * fix / plan (CLI > env > config > built-in default off in v6.0.x).
   */
  cliEngine?: boolean;
  envEngine?: string;
}

/**
 * Phase input — captured as a struct so the engine path's phase body matches
 * the engine-off path call signature.
 */
interface ReviewInput {
  cwd: string;
  context: string | null;
  outputPath: string;
}

/**
 * Phase output — JSON-serializable summary suitable for persistence as
 * `result` on phases/review.json. Mirrors what the legacy summary line
 * computes. A future skip-already-applied (Phase 6) could restore this
 * without re-running the review by reading the persisted log path.
 */
interface ReviewOutput {
  /** Absolute path to the written review log file. */
  reviewLogPath: string;
  /** Echoed for the render layer / future skip-already-applied. */
  context: string | null;
}

export async function runReview(options: ReviewCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  // v6.0.4 — engine resolution. CLI > env > config > default.
  //
  // INTENTIONAL DEVIATION FROM THE SPEC TABLE: the v6 spec
  // (docs/specs/v6-run-state-engine.md) lists `review` with
  // externalRefs `review-comments`, implying the phase posts review
  // comments to a GitHub PR (which would make `hasSideEffects: true`).
  // The implementation here does NOT post anywhere — it writes a review
  // log to a local file under .guardrail-cache/reviews/ and stops.
  // Posting per-line comments to a PR is owned by `claude-autopilot pr`
  // (which already has `--inline-comments` / `--post-comments`); the
  // `review` verb in v6.0.4 is the engine-wrap shell for the LLM-driven
  // code review skills (`/review`, `/review-2pass`,
  // `pr-review-toolkit:review-pr`) so pipeline runs can checkpoint a
  // `review` phase entry. Therefore `idempotent: true,
  // hasSideEffects: false` is correct for the wrapped behavior. If a
  // future PR adds platform-side comment posting to this verb, both
  // declarations will need to flip and the readback rules in the
  // wrapping recipe will need to plumb a `review-comments` externalRef.
  const engineResolved: ResolveEngineResult = resolveEngineEnabled({
    ...(options.cliEngine !== undefined ? { cliEngine: options.cliEngine } : {}),
    ...(options.envEngine !== undefined ? { envValue: options.envEngine } : {}),
    ...(typeof config.engine?.enabled === 'boolean' ? { configEnabled: config.engine.enabled } : {}),
  });

  const context = options.context ?? null;
  const outputPath = options.outputPath
    ? path.resolve(cwd, options.outputPath)
    : path.join(cwd, '.guardrail-cache', 'reviews', `${new Date().toISOString().replace(/[:.]/g, '-')}-review.md`);

  const reviewInput: ReviewInput = { cwd, context, outputPath };

  // The wrapped phase body — writes a review log stub to disk. The actual
  // LLM-driven review content is produced by the Claude Code review skills.
  // Engine-off callers invoke this directly via `executeReviewPhase()`;
  // engine-on callers route through `runPhase()`.
  const phase: RunPhase<ReviewInput, ReviewOutput> = {
    name: 'review',
    // Re-running the review verb against the same context writes the same
    // log file. Engine treats local file writes as overwrite-style — same
    // precedent as scan's findings-cache.
    idempotent: true,
    // Local file write only — no PR comment posting, no git push, no
    // provider-side mutation. See the long deviation note above where the
    // engine resolution is computed.
    hasSideEffects: false,
    run: async input => executeReviewPhase(input),
  };

  let output: ReviewOutput;
  if (engineResolved.enabled) {
    // v6.0.4 — wire review through the Run State Engine. Same shape as
    // scan / costs / fix / plan: createRun → runPhase → run.complete +
    // state.json refresh + best-effort lock release in finally.
    const created = await createRun({
      cwd,
      phases: ['review'],
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
      output = await runPhase<ReviewInput, ReviewOutput>(phase, reviewInput, {
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
      console.error(fmt('red', `[review] engine: phase failed — ${err instanceof Error ? err.message : String(err)}`));
      console.error(fmt('dim', `  inspect: claude-autopilot runs show ${created.runId} --events`));
      await created.lock.release();
      return 1;
    } finally {
      await created.lock.release().catch(() => { /* ignore */ });
    }
  } else {
    // Engine off — legacy stateless path. This is the v6.0.4 baseline; the
    // `review` CLI verb is new in v6.0.4 (review previously lived only as
    // Claude Code skills). Calling without --engine still writes the log
    // stub so the same-input → same-output guarantee holds.
    output = await executeReviewPhase(reviewInput);
  }

  return renderReviewOutput(output, reviewInput);
}

// ---------------------------------------------------------------------------
// Phase body — write a review log stub. Pure: no console output, no exit
// codes. Returns a JSON-serializable ReviewOutput so the engine can persist
// it as `result` on the phase snapshot. The actual LLM-driven review
// content is produced by the Claude Code review skills; this CLI verb's
// job is to provide a checkpointable phase shell.
// ---------------------------------------------------------------------------

async function executeReviewPhase(input: ReviewInput): Promise<ReviewOutput> {
  const { context, outputPath } = input;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const lines = [
    '# Review',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    context ? `Context: ${context}` : 'Context: (none provided)',
    '',
    '<!--',
    'This is the v6 engine-wrap stub for the `review` phase. The actual',
    'LLM-driven review content is produced by the Claude Code review skills',
    '(`/review`, `/review-2pass`, `pr-review-toolkit:review-pr`). The CLI',
    'verb exists to provide a checkpointable phase shell so',
    '`claude-autopilot runs show <id>` reflects a `review` phase entry when',
    'the pipeline includes one. PR-side comment posting lives in',
    '`claude-autopilot pr --inline-comments` / `--post-comments`, which is',
    'a separate verb.',
    '-->',
    '',
  ];
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');

  return {
    reviewLogPath: outputPath,
    context,
  };
}

// ---------------------------------------------------------------------------
// Render — translate ReviewOutput back to a stdout summary + exit code.
// Lives outside the wrapped phase because it's pure presentation.
// ---------------------------------------------------------------------------

function renderReviewOutput(output: ReviewOutput, input: ReviewInput): number {
  const { reviewLogPath, context } = output;
  const { cwd } = input;

  console.log('');
  console.log(fmt('bold', '[review]') + ' ' + fmt('dim', context ? `context: ${context}` : 'no context provided'));
  console.log(fmt('dim', `  → ${path.relative(cwd, reviewLogPath)}`));
  console.log('');
  console.log(fmt('cyan', 'Note:') + fmt('dim', ' the LLM-driven reviewer lives in Claude Code (superpowers:requesting-code-review,'));
  console.log(fmt('dim', '       /review, /review-2pass, pr-review-toolkit:review-pr).'));
  console.log(fmt('dim', '       PR comment posting lives in `claude-autopilot pr` (--inline-comments / --post-comments).'));
  console.log('');
  return 0;
}
