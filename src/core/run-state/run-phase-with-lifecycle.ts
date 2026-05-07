// src/core/run-state/run-phase-with-lifecycle.ts
//
// v6.0.6 — extract the lifecycle wrapper that's been duplicated across
// every wrapped CLI verb (`scan`, `costs`, `fix`, `brainstorm`, `spec`,
// `plan`, `review`, `validate`). The pattern is mechanical:
//
//   1. If engine-off → run the legacy phase body via `runEngineOff()` and
//      return its result.
//   2. If engine-on → createRun → optional run.warning for invalid env →
//      runPhase → emit run.complete (success or failed) → refresh state.json
//      → release lock (best effort, in finally).
//
// This helper sits ON TOP of `runPhase()` from `phase-runner.ts` — it does
// not replace it. Callers continue to define their own `RunPhase<I, O>` with
// per-phase `idempotent` / `hasSideEffects` / `run` and pass it in.
//
// Why now: with 8 of 10 phases wrapped (the v6.0.5 milestone), the pattern
// is fully evidenced. The remaining 3 phases (`implement`, `migrate`, `pr`)
// are side-effecting and need externalRefs — those will inform a v6.0.7+
// extension to this helper but won't change its core shape. Doing the
// extraction now means those 3 wraps build against the helper instead of
// re-introducing the boilerplate.
//
// What this helper does NOT do:
//   - Print success banners — rendering stays in the caller.
//   - Decide engine-off behavior — that's `runEngineOff`, supplied by the
//     caller (typically a thin closure over the phase body).
//   - Plumb externalRefs / readback — the underlying `runPhase()` already
//     handles those. This helper just owns the run-level lifecycle events.
//
// Future extension (v6.0.7+): `implement` / `migrate` / `pr` need
// externalRef ledger entries (`git-remote-push`, `migration-version`,
// `github-pr`). The helper's `phase.run` already receives `ctx` so
// `ctx.emitExternalRef()` works without changes here. If a future PR needs
// to fan-in run-wide externalRefs from multiple phases (multi-phase
// pipelines, e.g. autopilot orchestrator), the signature can grow a
// `phases: RunPhase[]` overload — but the single-phase shape stays identical.

import { createRun } from './runs.ts';
import { runPhase, type RunPhase } from './phase-runner.ts';
import { appendEvent, replayState } from './events.ts';
import { writeStateSnapshot } from './state.ts';
import {
  resolveEngineEnabled,
  emitEngineOffDeprecationWarning,
  type ResolveEngineResult,
} from './resolve-engine.ts';
import type { GuardrailConfig } from '../config/types.ts';

// Inline ANSI codes — same shape every wrapped verb uses. Kept here so the
// helper doesn't depend on a verb-local `fmt`. The error message format
// (`[<phase>] engine: phase failed — <msg>` + dim inspect hint) is
// byte-for-byte identical to what every wrapped phase printed pre-extract.
const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';
const ANSI_RED = '\x1b[31m';

/** Caller-supplied inputs to drive a single-phase engine run.
 *
 *  The helper is intentionally narrow: every wrapped verb passes the same
 *  shape today. Side-effecting verbs (`pr`, `migrate`, `implement`) will
 *  use the same shape too — they emit externalRefs from inside `phase.run`
 *  via `ctx.emitExternalRef()`, which the underlying `runPhase()` records.
 *  No new helper field is needed for them in v6.0.7+. */
export interface RunPhaseWithLifecycleOpts<I, O> {
  /** Project working directory. Passed straight through to `createRun`
   *  so `.guardrail-cache/runs/<ulid>/` lands in the right place. */
  cwd: string;
  /** The pre-built phase definition (name, idempotent, hasSideEffects, run).
   *  Same `RunPhase<I, O>` the caller would pass to `runPhase()` directly. */
  phase: RunPhase<I, O>;
  /** Phase input — same shape the caller would pass to `runPhase()`. */
  input: I;
  /** Loaded `guardrail.config.yaml` (or the default `{ configVersion: 1 }`).
   *  Used only for the `engine.enabled` precedence layer. The helper does
   *  NOT re-load config — that's the caller's responsibility (and lets
   *  callers pass synthetic configs in tests). */
  config: GuardrailConfig;
  /** CLI flag override — `true` from `--engine`, `false` from `--no-engine`,
   *  `undefined` if neither was passed. */
  cliEngine: boolean | undefined;
  /** Raw value of `process.env.CLAUDE_AUTOPILOT_ENGINE`. `undefined` if
   *  unset. The helper passes this through to `resolveEngineEnabled` —
   *  invalid values fall through with a `run.warning` recorded automatically. */
  envEngine: string | undefined;
  /** Engine-off escape hatch — what to return when `resolveEngineEnabled`
   *  decides the engine should NOT run. Most callers pass an async function
   *  that runs the legacy code path (typically the same `phase.run` body
   *  invoked without the lifecycle wrapper). The helper does not invoke
   *  `phase.run` for engine-off so the caller has full control over the
   *  legacy path's behavior — keeps engine-off byte-for-byte identical to
   *  pre-v6 behavior even when the phase body's signature would otherwise
   *  pin the call shape. */
  runEngineOff: () => Promise<O>;
}

/** What the helper hands back. `runId` and `runDir` are null on the
 *  engine-off path so callers can branch on whether engine artifacts exist
 *  (e.g. for a future `--json` envelope that surfaces the runId). */
export interface RunPhaseWithLifecycleResult<O> {
  output: O;
  /** ULID of the created run, or null when engine-off. */
  runId: string | null;
  /** Absolute path to the run dir, or null when engine-off. */
  runDir: string | null;
}

/** Drive a single-phase engine run with full lifecycle instrumentation,
 *  OR fall through to the legacy `runEngineOff` callback when the engine
 *  is disabled by config / CLI / env precedence.
 *
 *  Engine-on lifecycle (in order):
 *    createRun → (optional run.warning for invalid env) → runPhase →
 *    run.complete (success or failed) → refresh state.json → release lock.
 *
 *  On phase failure the helper:
 *    1. Emits `run.complete` with `status: 'failed'`.
 *    2. Refreshes state.json from the replayed events.
 *    3. Prints the legacy `[<phase>] engine: phase failed — <msg>` banner
 *       to stderr (byte-for-byte identical to the inline pattern that
 *       lived in 8 of 8 wrapped verbs pre-v6.0.6).
 *    4. Releases the lock and re-throws so the caller can return its
 *       legacy non-zero exit code.
 *
 *  The lock release in `finally` is best-effort. `release()` is idempotent
 *  (the runs lock module accepts double-release without throwing), so the
 *  catch block does not need to release the lock itself — `finally` covers
 *  both the success and failure exit paths. */
export async function runPhaseWithLifecycle<I, O>(
  opts: RunPhaseWithLifecycleOpts<I, O>,
): Promise<RunPhaseWithLifecycleResult<O>> {
  const { cwd, phase, input, config, cliEngine, envEngine, runEngineOff } = opts;

  // Resolve engine via the canonical precedence (CLI > env > config >
  // built-in default). The resolver is pure — same inputs always produce
  // the same decision. We DO consult the loaded config's `engine.enabled`
  // here so the helper's caller doesn't have to repeat the conditional
  // spread that every wrapped verb wrote inline.
  const engineResolved: ResolveEngineResult = resolveEngineEnabled({
    ...(cliEngine !== undefined ? { cliEngine } : {}),
    ...(envEngine !== undefined ? { envValue: envEngine } : {}),
    ...(typeof config.engine?.enabled === 'boolean'
      ? { configEnabled: config.engine.enabled }
      : {}),
  });

  if (!engineResolved.enabled) {
    // Engine off — call the caller's legacy path. No run dir, no events,
    // no lifecycle work. Behavior is byte-for-byte identical to pre-engine
    // versions of the verb. v6.1+ emits a one-line stderr deprecation
    // notice when the user explicitly opted out (CLI / env / config); the
    // v6.1 default is `enabled: true`, so a `'default'` source can't reach
    // this branch and the deprecation helper no-ops on the `enabled: true`
    // path. v7 removes the opt-out entirely.
    emitEngineOffDeprecationWarning(engineResolved);
    const output = await runEngineOff();
    return { output, runId: null, runDir: null };
  }

  // Engine on — full lifecycle. Mirrors the pre-v6.0.6 inline shape that
  // every wrapped verb duplicated.
  const created = await createRun({
    cwd,
    phases: [phase.name],
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
    const output = await runPhase<I, O>(phase, input, {
      runDir: created.runDir,
      runId: created.runId,
      writerId: created.lock.writerId,
      phaseIdx: 0,
    });

    // Final lifecycle event — run.complete. The runner doesn't emit this
    // on its own; it's the caller's responsibility (multi-phase pipelines
    // emit it after the LAST phase, single-phase wrappers like this emit
    // after the only phase). Total cost falls back to 0 when the phase
    // doesn't expose a `costUSD` field on its output (read-only verbs
    // don't track cost; scan does).
    const totalCostUSD = extractCostUSD(output);
    appendEvent(
      created.runDir,
      {
        event: 'run.complete',
        status: 'success',
        totalCostUSD,
        durationMs: Date.now() - runStartedAt,
      },
      { writerId: created.lock.writerId, runId: created.runId },
    );

    // Refresh state.json from the replayed events. The events.ndjson is
    // the source of truth; state.json is a derived snapshot that we MUST
    // rewrite after run.complete so `runs show` / `runs list` reflect the
    // terminal status without needing to replay on every read.
    writeStateSnapshot(created.runDir, replayState(created.runDir));

    return { output, runId: created.runId, runDir: created.runDir };
  } catch (err) {
    // Engine-on failure — write run.complete with failed status, refresh
    // state.json, print the legacy banner to stderr, then re-throw so the
    // caller can return its legacy non-zero exit code. (Lock release
    // happens in `finally` regardless of success / failure path.)
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
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${ANSI_RED}[${phase.name}] engine: phase failed — ${message}${ANSI_RESET}\n`,
    );
    process.stderr.write(
      `${ANSI_DIM}  inspect: claude-autopilot runs show ${created.runId} --events${ANSI_RESET}\n`,
    );
    throw err;
  } finally {
    // Best-effort lock release. The lock module's `release()` is
    // idempotent; if the catch path already released (it doesn't, but a
    // future change might), this is a no-op. Wrapping the await in
    // `.catch(() => {})` ensures a release error never masks the original
    // throw — the spec calls this out explicitly.
    await created.lock.release().catch(() => { /* ignore — best effort */ });
  }
}

/** Extract `costUSD` from a phase output if present, else 0. JSON-style
 *  duck-typing: we accept any output that exposes a numeric `costUSD`
 *  field. Today only `scan` exposes one; the other 7 wrapped verbs
 *  return outputs without a cost field, which means `extractCostUSD`
 *  returns 0 — byte-for-byte matching the inline `totalCostUSD: 0` they
 *  used pre-v6.0.6. */
function extractCostUSD(output: unknown): number {
  if (output !== null && typeof output === 'object' && 'costUSD' in output) {
    const v = (output as { costUSD?: unknown }).costUSD;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

