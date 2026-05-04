// src/cli/json-mode.ts
//
// v6 Phase 5 — strict --json channel discipline.
//
// When --json is set, the spec mandates:
//   - stdout: exactly one JSON envelope per command invocation.
//   - stderr: only NDJSON event lines. No human-readable warnings, no color.
//   - All warnings / prompts / human diagnostics route to typed events.
//   - Interactive prompts hard-fail with exit:78.
//
// Many existing CLI handlers call `console.log` / `console.error` /
// `console.warn` / `process.stdout.write` / `process.stderr.write` directly
// for human output. Migrating each one to thread a json flag and switch
// behavior would be a multi-thousand-line patch. Instead, we install a
// channel-discipline shim BEFORE the handler runs that captures every
// non-NDJSON-shaped write and reroutes it:
//
//   - stdout writes that aren't valid JSON       → captured into messages[]
//                                                   (will be attached to the
//                                                   final envelope by the
//                                                   dispatcher).
//   - stdout writes that ARE valid JSON          → captured raw (the dispatcher
//                                                   will pick the LAST one as
//                                                   the envelope, on the
//                                                   assumption that handlers
//                                                   that already emit a JSON
//                                                   envelope want it to win).
//   - stderr writes that are NDJSON              → passed through as-is.
//   - stderr writes that aren't NDJSON           → wrapped in a synthetic
//                                                   run.warning event and
//                                                   re-emitted as NDJSON.
//
// Console wrappers route through the same shim:
//   console.log -> stdout shim
//   console.error / console.warn -> stderr shim (with level metadata)
//
// All ANSI color codes are stripped on the way out.
//
// The shim is restorable — the dispatcher calls `restore()` after the
// handler completes so test runs (which spawn many handlers in-process) get
// a clean slate.

import { stripAnsi, syntheticRunWarning } from './json-envelope.ts';

export interface CapturedMessage {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  text: string;
}

export interface JsonModeChannelHandle {
  /** Restore stdout/stderr/console to pre-install state. Idempotent. */
  restore: () => void;
  /** All non-JSON stdout writes captured during the handler's lifetime. */
  capturedMessages: CapturedMessage[];
  /** All raw JSON-parseable strings written to stdout, in order. The
   *  dispatcher's convention: if a handler already emits its own envelope,
   *  the LAST one wins and is reused as the envelope's command-specific
   *  payload base. */
  capturedJsonStdout: unknown[];
}

/** Try to JSON.parse a chunk. Returns the parsed value on success, undefined
 *  on failure. We strip a trailing newline before parsing so handlers writing
 *  one envelope per line are accepted. */
function tryParse(chunk: string): unknown | undefined {
  const trimmed = chunk.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Coerce an unknown buffer/string into a string. Mirrors Node's stream
 *  semantics where writes accept either. */
function toText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

/** Install the channel-discipline shim. Returns a handle the caller uses to
 *  collect captured output and to restore the original state.
 *
 *  Safe to call when --json is OFF — the function is a no-op in that case
 *  (returns a handle whose restore() does nothing and whose buffers stay
 *  empty). Callers should still respect the active flag and skip the
 *  envelope emission in text mode. */
export function installJsonModeChannelDiscipline(opts: { active: boolean } = { active: true }): JsonModeChannelHandle {
  const capturedMessages: CapturedMessage[] = [];
  const capturedJsonStdout: unknown[] = [];

  if (!opts.active) {
    return {
      restore: () => {},
      capturedMessages,
      capturedJsonStdout,
    };
  }

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origConsoleLog = console.log;
  const origConsoleError = console.error;
  const origConsoleWarn = console.warn;
  const origConsoleInfo = console.info;
  const origConsoleDebug = console.debug;

  /** Splits a chunk on newlines, tries to JSON.parse each non-empty line.
   *  Lines that parse as JSON are recorded as JSON envelopes; the rest are
   *  recorded as captured text messages with the given level. */
  function captureStdout(chunk: string, level: CapturedMessage['level']): void {
    const cleaned = stripAnsi(chunk);
    // Stdout chunks may contain multiple JSON envelopes back-to-back; split
    // on newlines and parse each line. We treat the WHOLE chunk as a single
    // text message if no line parses (preserves multi-line formatted text).
    const lines = cleaned.split('\n');
    let anyParsed = false;
    for (const line of lines) {
      const parsed = tryParse(line);
      if (parsed !== undefined) {
        capturedJsonStdout.push(parsed);
        anyParsed = true;
      }
    }
    if (!anyParsed && cleaned.trim().length > 0) {
      capturedMessages.push({ level, text: cleaned.replace(/\n+$/, '') });
    }
  }

  /** Splits a chunk on newlines for stderr. NDJSON lines pass through to the
   *  real stderr; non-NDJSON lines are wrapped in synthetic run.warning
   *  events and re-emitted. */
  function captureStderr(chunk: string, level: CapturedMessage['level']): void {
    const cleaned = stripAnsi(chunk);
    const lines = cleaned.split('\n');
    for (const line of lines) {
      if (line.length === 0) continue;
      const parsed = tryParse(line);
      if (parsed !== undefined) {
        // Pass through as-is (with trailing newline) — already NDJSON.
        origStderrWrite(line + '\n');
      } else {
        const ev = syntheticRunWarning(line, { level });
        origStderrWrite(JSON.stringify(ev) + '\n');
      }
    }
  }

  // Wrap process.stdout.write. Note: returning true keeps the stream
  // signature truthy; we drop the original write entirely under JSON mode
  // because every byte is captured and re-routed via the envelope.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    captureStdout(toText(chunk), 'log');
    // Honor the optional callback signature so caller code that passes one
    // (rare in our handlers but possible) doesn't hang.
    const cb = rest.find(r => typeof r === 'function') as ((err?: Error) => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    captureStderr(toText(chunk), 'warn');
    const cb = rest.find(r => typeof r === 'function') as ((err?: Error) => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stderr.write;

  console.log = (...args: unknown[]) => {
    captureStdout(args.map(toText).join(' ') + '\n', 'log');
  };
  console.info = (...args: unknown[]) => {
    captureStdout(args.map(toText).join(' ') + '\n', 'info');
  };
  console.debug = (...args: unknown[]) => {
    captureStdout(args.map(toText).join(' ') + '\n', 'debug');
  };
  console.warn = (...args: unknown[]) => {
    captureStderr(args.map(toText).join(' ') + '\n', 'warn');
  };
  console.error = (...args: unknown[]) => {
    captureStderr(args.map(toText).join(' ') + '\n', 'error');
  };

  let restored = false;
  function restore(): void {
    if (restored) return;
    restored = true;
    process.stdout.write = origStdoutWrite as typeof process.stdout.write;
    process.stderr.write = origStderrWrite as typeof process.stderr.write;
    console.log = origConsoleLog;
    console.error = origConsoleError;
    console.warn = origConsoleWarn;
    console.info = origConsoleInfo;
    console.debug = origConsoleDebug;
  }

  return { restore, capturedMessages, capturedJsonStdout };
}

/** Build a ChannelOptions value from the parsed --json flag plus
 *  process.stdin TTY-ness. The caller (dispatcher) usually wants the
 *  computed nonInteractive flag for prompt-or-hard-fail decisions. */
export function computeChannelOptions(json: boolean): { json: boolean; nonInteractive: boolean } {
  return {
    json,
    nonInteractive: json || !process.stdin.isTTY,
  };
}
