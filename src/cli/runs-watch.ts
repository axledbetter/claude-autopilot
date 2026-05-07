// src/cli/runs-watch.ts
//
// `runs watch <runId>` — tails a run's events.ndjson and renders a live
// cost/token meter that updates as phases execute.
//
// Tail strategy: fs.watchFile with a 1s polling interval. fs.watch (inotify
// on Linux, FSEvents on macOS) is unreliable for append-only logs in our
// matrix — it sometimes never fires for tiny appends, sometimes fires twice
// per write. Polling is consistent across darwin / linux / win32 and the
// 1-second cadence is plenty for a human-facing meter.
//
// Modes:
//   default          pretty-rendered live tail (header + per-event lines + final summary)
//   --no-follow      render snapshot once, exit
//   --json           emit raw NDJSON to stdout (for piping to jq / dashboards)
//   --since <seq>    replay forward from a specific seq (resume after disconnect)
//
// Spec: tasks/v6.1-runs-watch.md.

import * as fs from 'node:fs';
import { GuardrailError } from '../core/errors.ts';
import { foldEvents, readEvents, eventsPath } from '../core/run-state/events.ts';
import { readStateSnapshot } from '../core/run-state/state.ts';
import { runDirFor } from '../core/run-state/runs.ts';
import { isValidULID } from '../core/run-state/ulid.ts';
import type { BudgetConfig } from '../core/run-state/budget.ts';
import type { RunEvent, RunState } from '../core/run-state/types.ts';
import {
  renderEventLine,
  renderFinalSummary,
  renderHeader,
  type FinalSummary,
  type RenderOptions,
} from './runs-watch-renderer.ts';

// ----------------------------------------------------------------------------
// Shared CLI result envelope (matches the shape used by the other runs verbs).
// We don't import the type from runs.ts because it's not exported; the shape
// is documented + asserted by tests.
// ----------------------------------------------------------------------------

export interface RunsWatchCliResult {
  exit: number;
  stdout: string[];
  stderr: string[];
}

// ----------------------------------------------------------------------------
// Options.
// ----------------------------------------------------------------------------

export interface RunRunsWatchOptions {
  runId: string;
  cwd?: string;
  /** Replay forward from this seq (1-based, matching the events.ndjson seq
   *  field). Useful for resuming a watch after a disconnect. */
  since?: number;
  /** When true, render snapshot once and exit. No file watcher, no Ctrl-C
   *  handler. Useful for one-shot status pulls. */
  noFollow?: boolean;
  /** When true, emit raw NDJSON (one event per line) to stdout instead of the
   *  pretty rendering. ANSI is forced off. */
  json?: boolean;
  /** When true, force ANSI off regardless of TTY detection. Honored even
   *  in default mode (e.g. `claude-autopilot runs watch <id> --no-color`). */
  noColor?: boolean;

  // ---- Test seams. Production callers must not pass these. ----------------

  /** Override TTY detection. Tests pass `false` to assert ANSI-stripped
   *  output. Production callers leave undefined; the verb consults
   *  `process.stdout.isTTY`. */
  __testIsTTY?: boolean;
  /** Override `process.stdout.write`. Tests pass a buffer-collector so
   *  they can assert on emitted lines without spawning. */
  __testWriteStdout?: (chunk: string) => void;
  /** Override `process.stderr.write`. Same shape as above. */
  __testWriteStderr?: (chunk: string) => void;
  /** Override the polling interval (ms). Default 1000; tests pass a much
   *  smaller value to make live-tail tests run quickly. */
  __testPollIntervalMs?: number;
  /** When set, the verb resolves with this status the moment the watcher
   *  observes a `run.complete` (or matching terminal event). Tests use this
   *  to assert the auto-exit-on-completion behavior without a real signal. */
  __testStopAfterTerminal?: boolean;
}

// ----------------------------------------------------------------------------
// Implementation.
// ----------------------------------------------------------------------------

/** ULID validation, mirrors the helper in runs.ts. Inlined to avoid an
 *  internal import that isn't exported. */
function assertValidRunId(runId: string | undefined): asserts runId is string {
  if (!runId) {
    throw new GuardrailError('a run id is required', {
      code: 'invalid_config',
      provider: 'runs-cli',
      details: { runId },
    });
  }
  if (!isValidULID(runId)) {
    throw new GuardrailError(`run id is not a valid ULID: ${runId}`, {
      code: 'invalid_config',
      provider: 'runs-cli',
      details: { runId },
    });
  }
}

function formatErr(err: unknown): string {
  if (err instanceof GuardrailError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Pull a `BudgetConfig` out of `RunState.config` if one was recorded at
 *  run-creation time. Returns null on any shape mismatch — we never throw,
 *  the watcher should degrade gracefully when the budget block is absent. */
function extractBudget(state: RunState): BudgetConfig | null {
  const cfg = state.config;
  if (!cfg || typeof cfg !== 'object') return null;
  // Two recognized shapes:
  //   1. `config.budget = { perRunUSD: ..., ... }` (preferred — matches
  //      what `BudgetConfig` looks like in budget.ts)
  //   2. `config.budgets = { perRunUSD: ..., ... }` (yaml plural alias —
  //      matches what guardrail.config.yaml uses; see migration-guide.md
  //      "Budget config" section)
  const candidate = (cfg as Record<string, unknown>).budget
    ?? (cfg as Record<string, unknown>).budgets;
  if (!candidate || typeof candidate !== 'object') return null;
  const c = candidate as Record<string, unknown>;
  if (typeof c.perRunUSD !== 'number') return null;
  const out: BudgetConfig = { perRunUSD: c.perRunUSD };
  if (typeof c.perPhaseUSD === 'number') out.perPhaseUSD = c.perPhaseUSD;
  if (typeof c.conservativePhaseReserveUSD === 'number') {
    out.conservativePhaseReserveUSD = c.conservativePhaseReserveUSD;
  }
  return out;
}

/** Fold the events list into a (totalCostUSD, terminalEvent) tuple. The
 *  watcher uses this to know when to stop following — a terminal event is
 *  any `run.complete`, the run-level `status` field on it, or a marker
 *  event the verb treats as terminal. */
function isTerminalEvent(ev: RunEvent): boolean {
  if (ev.event === 'run.complete') return true;
  return false;
}

/** Public entry point — exported so the dispatcher in runs.ts can call us
 *  uniformly with the other verbs.  */
export async function runRunsWatch(
  opts: RunRunsWatchOptions,
): Promise<RunsWatchCliResult> {
  const cwd = opts.cwd ?? process.cwd();
  const json = !!opts.json;

  // ---- 1. Validate inputs --------------------------------------------------

  try {
    assertValidRunId(opts.runId);
  } catch (err) {
    return {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs watch: ${formatErr(err)}`],
    };
  }

  const runDir = runDirFor(cwd, opts.runId);
  if (!fs.existsSync(runDir)) {
    const err = new GuardrailError(`run not found: ${opts.runId}`, {
      code: 'not_found',
      provider: 'runs-cli',
      details: { runId: opts.runId, runDir },
    });
    return {
      exit: 2,
      stdout: [],
      stderr: [`[claude-autopilot] runs watch: ${formatErr(err)}`],
    };
  }

  if (opts.since !== undefined && (!Number.isFinite(opts.since) || opts.since < 0)) {
    const err = new GuardrailError(
      `--since must be a non-negative integer (got ${opts.since})`,
      { code: 'invalid_config', provider: 'runs-cli', details: { since: opts.since } },
    );
    return {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] runs watch: ${formatErr(err)}`],
    };
  }

  // ---- 2. Decide ANSI mode -------------------------------------------------
  //
  // ansi=true iff:
  //   - not --json mode, AND
  //   - --no-color was not passed, AND
  //   - NO_COLOR env var not set, AND
  //   - stdout is a TTY (via the test seam or the real flag)
  const realIsTTY = opts.__testIsTTY !== undefined ? opts.__testIsTTY : !!process.stdout.isTTY;
  const ansi = !json && !opts.noColor && !process.env.NO_COLOR && realIsTTY;
  const renderOpts: RenderOptions = { ansi };

  // ---- 3. Read initial state -----------------------------------------------

  let state: RunState | null;
  try {
    state = readStateSnapshot(runDir);
  } catch {
    state = null;
  }
  // Fall back to events replay if state.json is missing/corrupt — this is
  // the same path runs show takes. Watch should never refuse to start on
  // snapshot drift; events.ndjson is authoritative.
  if (!state) {
    try {
      state = foldEvents(runDir, readEvents(runDir).events);
    } catch (err) {
      return {
        exit: 1,
        stdout: [],
        stderr: [`[claude-autopilot] runs watch: ${formatErr(err)}`],
      };
    }
  }
  const budget = extractBudget(state);

  // The output sinks. In tests these are buffer-collectors; in production
  // they wrap process.stdout / process.stderr.
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const writeStdout = opts.__testWriteStdout
    ?? ((s: string) => { stdoutLines.push(s.endsWith('\n') ? s.slice(0, -1) : s); });
  const writeStderr = opts.__testWriteStderr
    ?? ((s: string) => { stderrLines.push(s.endsWith('\n') ? s.slice(0, -1) : s); });

  // ---- 4. Snapshot mode (--no-follow) --------------------------------------

  if (opts.noFollow) {
    const since = opts.since ?? 0;
    let runningTotal = 0;
    let allEvents: RunEvent[];
    try {
      allEvents = readEvents(runDir).events;
    } catch (err) {
      return {
        exit: 1,
        stdout: [],
        stderr: [`[claude-autopilot] runs watch: ${formatErr(err)}`],
      };
    }
    if (json) {
      // JSON mode: dump every event from `since` forward as raw NDJSON.
      // Strict channel discipline — exactly the bytes that landed on disk.
      for (const ev of allEvents) {
        if (ev.seq < since) continue;
        writeStdout(JSON.stringify(ev) + '\n');
      }
      return finishOk(stdoutLines, stderrLines);
    }
    // Pretty: header + every event-line.
    for (const line of renderHeader(state, budget, renderOpts)) writeStdout(line + '\n');
    for (const ev of allEvents) {
      if (ev.seq < since) continue;
      if (ev.event === 'phase.cost') runningTotal += ev.costUSD;
      writeStdout(renderEventLine(ev, runningTotal, renderOpts) + '\n');
    }
    // Final summary if the run terminated.
    if (state.status === 'success' || state.status === 'failed' || state.status === 'aborted') {
      const summary: FinalSummary = {
        runId: state.runId,
        status: state.status,
        totalCostUSD: state.totalCostUSD,
        durationMs: computeDurationMs(state),
      };
      for (const line of renderFinalSummary(summary, renderOpts)) writeStdout(line + '\n');
    }
    return finishOk(stdoutLines, stderrLines);
  }

  // ---- 5. Live tail mode ---------------------------------------------------

  // We re-read the file from byte 0 each poll cycle (simpler than offset
  // tracking and the file is bounded). We track lastSeq to decide which
  // events are new. The `since` flag is treated as a floor on what we
  // print, not on what we read — we always need the full event stream
  // to compute runningTotal correctly.
  const since = opts.since ?? 0;
  let lastSeq = 0;
  let runningTotal = 0;

  // Print header up front (default mode only — JSON pipes the raw stream).
  if (!json) {
    for (const line of renderHeader(state, budget, renderOpts)) writeStdout(line + '\n');
  }

  // Drain whatever's already on disk.
  const initialEvents = readEvents(runDir).events;
  for (const ev of initialEvents) {
    if (ev.event === 'phase.cost') runningTotal += ev.costUSD;
    if (ev.seq >= since) {
      if (json) writeStdout(JSON.stringify(ev) + '\n');
      else writeStdout(renderEventLine(ev, runningTotal, renderOpts) + '\n');
    }
    lastSeq = Math.max(lastSeq, ev.seq);
  }

  // Did the run already terminate before we started watching? Short-circuit
  // so the verb doesn't hang waiting for events that will never arrive.
  const terminalAlready = initialEvents.some(isTerminalEvent);
  if (terminalAlready) {
    if (!json) {
      const finalState = foldEvents(runDir, initialEvents);
      const summary: FinalSummary = {
        runId: finalState.runId,
        status: finalState.status,
        totalCostUSD: finalState.totalCostUSD,
        durationMs: computeDurationMs(finalState),
      };
      for (const line of renderFinalSummary(summary, renderOpts)) writeStdout(line + '\n');
    }
    return finishOk(stdoutLines, stderrLines);
  }

  // Set up the polling watcher.
  const eventsFile = eventsPath(runDir);
  const pollInterval = opts.__testPollIntervalMs ?? 1000;
  let lastFileSize = fs.existsSync(eventsFile) ? fs.statSync(eventsFile).size : 0;

  return await new Promise<RunsWatchCliResult>(resolve => {
    let resolved = false;
    let sigintHandler: (() => void) | null = null;

    const finish = (status: 'completed' | 'interrupted' | 'error', errMsg?: string) => {
      if (resolved) return;
      resolved = true;
      try { fs.unwatchFile(eventsFile); } catch { /* ignore */ }
      if (sigintHandler) {
        try { process.off('SIGINT', sigintHandler); } catch { /* ignore */ }
      }
      // Final summary in pretty mode.
      if (!json) {
        try {
          const finalEvents = readEvents(runDir).events;
          const finalState = foldEvents(runDir, finalEvents);
          const summary: FinalSummary = {
            runId: finalState.runId,
            // For Ctrl-C (interrupted) we tag the summary that way even
            // though the run itself may still be running. The renderer
            // colors `interrupted` as bold-yellow.
            status: status === 'interrupted' ? 'interrupted' : finalState.status,
            totalCostUSD: finalState.totalCostUSD,
            durationMs: computeDurationMs(finalState),
          };
          for (const line of renderFinalSummary(summary, renderOpts)) {
            writeStdout(line + '\n');
          }
        } catch {
          // Ignore — final summary is best-effort.
        }
      }
      const exit = status === 'error' ? 1 : 0;
      const result: RunsWatchCliResult = {
        exit,
        stdout: stdoutLines,
        stderr: errMsg
          ? [...stderrLines, `[claude-autopilot] runs watch: ${errMsg}`]
          : stderrLines,
      };
      resolve(result);
    };

    const tick = () => {
      // File-shrink recovery: if the file is smaller than last poll the
      // log was rotated/truncated externally — re-read from start.
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(eventsFile);
      } catch {
        // File doesn't exist yet — wait for it.
        return;
      }
      if (stat.size < lastFileSize) {
        // Truncation. Reset and re-fold from scratch.
        lastSeq = 0;
        runningTotal = 0;
      }
      lastFileSize = stat.size;
      let events: RunEvent[];
      try {
        events = readEvents(runDir).events;
      } catch (err) {
        // Mid-log corruption — surface and exit. The runs doctor verb
        // can be used to diagnose / fix.
        finish('error', formatErr(err));
        return;
      }
      for (const ev of events) {
        if (ev.seq <= lastSeq) continue;
        if (ev.event === 'phase.cost') runningTotal += ev.costUSD;
        if (ev.seq >= since) {
          if (json) writeStdout(JSON.stringify(ev) + '\n');
          else writeStdout(renderEventLine(ev, runningTotal, renderOpts) + '\n');
        }
        lastSeq = ev.seq;
        if (isTerminalEvent(ev)) {
          // Run terminated — drain remaining events (already done in the
          // loop) and exit.
          finish('completed');
          return;
        }
      }
    };

    // fs.watchFile polls at the interval we pass; the listener fires when
    // mtime changes. We do an explicit tick on each fire because the file
    // size delta isn't enough on its own (an event could land between
    // polls).
    fs.watchFile(eventsFile, { interval: pollInterval, persistent: true }, () => {
      tick();
    });

    // Ctrl-C — clean exit with summary. The handler is removed by `finish`.
    if (!opts.__testStopAfterTerminal) {
      sigintHandler = () => finish('interrupted');
      process.on('SIGINT', sigintHandler);
    }

    // First tick — we already drained initial events above, but kicking
    // tick() once here covers the rare race where new events appended
    // between our drain and our watchFile registration.
    tick();
  });
}

/** Compute wall-clock duration from a state snapshot. Used in the final
 *  summary line. Falls back to 0 if the run hasn't started or the timestamps
 *  are malformed. */
function computeDurationMs(state: RunState): number {
  const start = Date.parse(state.startedAt);
  if (!Number.isFinite(start)) return 0;
  const end = state.endedAt ? Date.parse(state.endedAt) : Date.now();
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function finishOk(stdout: string[], stderr: string[]): RunsWatchCliResult {
  return { exit: 0, stdout, stderr };
}
