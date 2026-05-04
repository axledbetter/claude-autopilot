// src/cli/json-envelope.ts
//
// v6 Phase 5 — typed JSON envelope + strict --json channel discipline helpers.
//
// Spec: docs/specs/v6-run-state-engine.md "CLI `--json` mode + strict channel
// discipline (Codex WARNING)". The contract:
//
//   - When `--json` is set on ANY command, stdout receives EXACTLY ONE JSON
//     envelope per command invocation. Nothing else.
//   - stderr receives ONLY NDJSON event lines (one JSON object per line). No
//     human-readable warnings, no progress bars, no color codes.
//   - All warnings / prompts / human diagnostics route to typed events
//     (run.warning, run.recovery, phase.needs-human, budget.check, ...).
//   - Interactive prompts in --json mode hard-fail with exit:78 ("needs-human
//     in non-interactive mode") and the envelope's nextActions field carries
//     the resume hint.
//
// Phase 3 (`runs` verbs) shipped a v1 envelope without strict channel
// discipline; Phase 5 layers the discipline on top via `installJsonMode`
// in json-mode.ts. This module owns the pure types + emission helpers; the
// hook installer lives next door so the type surface here stays trivially
// importable from anywhere (helpers, formatters, tests) without dragging in
// the side-effecting console-wrap.

import type { RunEvent, RunEventInput } from '../core/run-state/types.ts';

/** Envelope schema version. Bumped on breaking changes to JsonEnvelope shape.
 *  Mirrors RUN_STATE_SCHEMA_VERSION but is independent — events can change
 *  without forcing the envelope shape to change, and vice versa. */
export const JSON_ENVELOPE_SCHEMA_VERSION = 1 as const;
export type JsonEnvelopeSchemaVersion = typeof JSON_ENVELOPE_SCHEMA_VERSION;

/** Custom exit code reserved for "interactive prompt would fire in --json
 *  mode". Keeps the contract observable to CI consumers — they can branch on
 *  this specific code to decide "needs-human, resume hint is in
 *  envelope.nextActions". 78 is borrowed from sysexits.h's EX_CONFIG; we
 *  redefine it as "needs-human in non-interactive mode" for our purposes. */
export const EXIT_NEEDS_HUMAN = 78 as const;

/** Status surfaced in the envelope. Free-form so per-command results can use
 *  command-specific statuses (e.g. "applied" for migrate); the canonical
 *  three-state alphabet is `pass | fail | partial`. */
export type JsonEnvelopeStatus = 'pass' | 'fail' | 'partial' | string;

/** The canonical envelope shape. Command-specific result payloads ride on
 *  top via the index signature so individual commands can attach their own
 *  fields (`findings`, `runs`, `deploy`, etc.) without forcing a megaschema
 *  here. */
export interface JsonEnvelope {
  /** Bumped when shape changes break consumers. Always 1 for Phase 5. */
  schema_version: JsonEnvelopeSchemaVersion;
  /** The CLI verb this envelope is for. e.g. "scan", "runs list", "deploy". */
  command: string;
  /** Optional run id — present for engine-aware verbs that produced or
   *  inspected a run. */
  runId?: string;
  /** Top-level pass/fail. Mirrors `exit === 0` for most verbs; some verbs
   *  use `partial` when they completed but with caveats. */
  status: JsonEnvelopeStatus;
  /** Wall-clock duration the verb took to execute, in milliseconds. */
  durationMs: number;
  /** Cumulative LLM spend during this verb. Optional — verbs that don't
   *  spend (doctor, runs list, etc.) omit the field entirely. */
  costUSD?: number;
  /** Process exit code. MUST equal what the CLI returns. */
  exit: number;
  /** Hints for resuming after a needs-human exit — surfaced in the envelope
   *  so CI can react without re-running the verb. Spec requires this on the
   *  EXIT_NEEDS_HUMAN path. */
  nextActions?: string[];
  /** Human-readable error code/message (e.g. when status === 'fail'). */
  error?: string;
  /** Free-form messages routed through console.* under JSON-mode discipline.
   *  Populated by json-mode.ts when stdout/stderr writes happen mid-verb so
   *  no bytes are lost; the envelope captures them as a typed channel
   *  instead of letting them pollute stdout. */
  messages?: Array<{
    level: 'log' | 'warn' | 'error' | 'info' | 'debug';
    text: string;
  }>;
  /** Command-specific result payload. */
  [key: string]: unknown;
}

/** Strip all ANSI color escape sequences from a string. Color codes in
 *  --json mode are a contract violation (they're text noise inside what's
 *  supposed to be a clean machine-readable line). */
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Emit the envelope as exactly one stdout line. The newline IS the
 *  separator — consumers calling `JSON.parse(stdout)` should split on `\n`
 *  if they spawn the CLI more than once. */
export function emitEnvelope(env: JsonEnvelope): void {
  // Defensive: validate the shape so we fail loud rather than emitting a
  // malformed envelope. This catches handler bugs at the seam where text
  // would have been ok but JSON consumers will crash on JSON.parse.
  if (env.schema_version !== JSON_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(
      `[json-envelope] schema_version must be ${JSON_ENVELOPE_SCHEMA_VERSION}, got ${env.schema_version}`,
    );
  }
  if (typeof env.command !== 'string' || env.command.length === 0) {
    throw new Error('[json-envelope] command must be a non-empty string');
  }
  if (typeof env.exit !== 'number' || !Number.isInteger(env.exit)) {
    throw new Error('[json-envelope] exit must be an integer');
  }
  if (typeof env.durationMs !== 'number' || env.durationMs < 0) {
    throw new Error('[json-envelope] durationMs must be a non-negative number');
  }
  // Strip ANSI from any error / message text — defence in depth against a
  // handler that built its `error` string by interpolating a colorized
  // formatted message.
  const cleaned: JsonEnvelope = { ...env };
  if (typeof cleaned.error === 'string') cleaned.error = stripAnsi(cleaned.error);
  if (Array.isArray(cleaned.messages)) {
    cleaned.messages = cleaned.messages.map(m => ({ ...m, text: stripAnsi(m.text) }));
  }
  process.stdout.write(JSON.stringify(cleaned) + '\n');
}

/** Emit a typed event as a single NDJSON line on stderr.
 *
 *  In --json mode this is the ONLY thing that should appear on stderr (other
 *  than the universal envelope-on-stdout). The event is JSON.stringified
 *  whole — it carries its own seq / ts / runId / writerId from the appender
 *  if it came out of the run-state engine, or a partial shape if it's a
 *  CLI-synthetic warning routed via console.warn. */
export function emitStderrEvent(event: RunEvent | RunEventInput | Record<string, unknown>): void {
  process.stderr.write(JSON.stringify(event) + '\n');
}

/** Channel options carried alongside per-verb opts. Uniform across every
 *  migrated verb so the dispatcher in index.ts can decide once. */
export interface ChannelOptions {
  json: boolean;
  /** True when --json is set, OR when stdin is non-TTY, OR when an explicit
   *  --non-interactive flag is set. Verbs use this to decide whether to
   *  prompt or hard-fail. */
  nonInteractive: boolean;
}

/** Build a synthetic run.warning-shaped event for CLI-side warnings that
 *  predate the engine instrumentation. Has no runId / seq / writerId because
 *  the CLI invocation may not have a run attached. Consumers MAY still drop
 *  it; spec only requires the envelope-on-stdout discipline. */
export function syntheticRunWarning(message: string, details?: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    ts: new Date().toISOString(),
    event: 'run.warning',
    message: stripAnsi(message),
    ...(details ? { details } : {}),
  };
}

/** Run an arbitrary CLI handler under --json channel discipline.
 *
 *  The handler returns its exit code (the same shape every existing handler
 *  uses today). On the way out, we package up:
 *    - status (pass/fail derived from exit)
 *    - durationMs (wall clock from start)
 *    - messages[] (anything the handler wrote to stdout/stderr)
 *    - command-specific payload (whatever the handler returned via the
 *      `payload` callback if present, OR the last raw JSON envelope the
 *      handler emitted itself, whichever is more informative)
 *
 *  This is the wrapper used by index.ts to migrate verbs one-by-one without
 *  rewriting their internals. Verbs that already emit a Phase 3 envelope
 *  (the `runs` verbs) bypass this wrapper since they already build their
 *  own envelope and can route directly to emitEnvelope.
 *
 *  When `active` is false, this is a thin pass-through that just forwards
 *  the handler's exit code — text-mode behavior is unchanged. */
export interface RunUnderJsonModeOptions {
  command: string;
  active: boolean;
  /** Optional callback that returns command-specific result fields to merge
   *  into the envelope. Called AFTER the handler completes. */
  payload?: (capturedJsonStdout: unknown[]) => Record<string, unknown>;
  /** Optional override for the envelope status. Default: derived from exit
   *  (0 → 'pass', otherwise 'fail'). */
  statusFor?: (exit: number) => JsonEnvelopeStatus;
}

export async function runUnderJsonMode(
  opts: RunUnderJsonModeOptions,
  handler: () => Promise<number | void>,
): Promise<number> {
  const { installJsonModeChannelDiscipline } = await import('./json-mode.ts');
  const start = Date.now();
  const handle = installJsonModeChannelDiscipline({ active: opts.active });
  let exit = 0;
  let caughtError: unknown;
  try {
    const result = await handler();
    exit = typeof result === 'number' ? result : 0;
  } catch (err) {
    caughtError = err;
    exit = 1;
  } finally {
    handle.restore();
  }
  if (!opts.active) {
    if (caughtError) throw caughtError;
    return exit;
  }
  const status = opts.statusFor ? opts.statusFor(exit) : (exit === 0 ? 'pass' : 'fail');
  // Prefer the handler's own JSON envelope (last one wins) as the payload
  // base — handlers that already emit Phase 3 envelopes get their fields
  // surfaced through the wrapper's envelope.
  let basePayload: Record<string, unknown> = {};
  const lastJson = handle.capturedJsonStdout[handle.capturedJsonStdout.length - 1];
  if (lastJson && typeof lastJson === 'object') {
    basePayload = { ...(lastJson as Record<string, unknown>) };
    // Strip envelope-internal fields the handler may have set so the wrapper
    // doesn't double them up; the wrapper's own values are authoritative.
    delete basePayload.schema_version;
    delete basePayload.command;
    delete basePayload.status;
    delete basePayload.exit;
    delete basePayload.durationMs;
  }
  const extra = opts.payload ? opts.payload(handle.capturedJsonStdout) : {};
  const env: JsonEnvelope = {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    command: opts.command,
    status,
    exit,
    durationMs: Date.now() - start,
    ...basePayload,
    ...extra,
    ...(handle.capturedMessages.length > 0 ? { messages: handle.capturedMessages } : {}),
    ...(caughtError instanceof Error ? { error: caughtError.message } : {}),
  };
  emitEnvelope(env);
  return exit;
}
