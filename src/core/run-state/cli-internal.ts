// src/core/run-state/cli-internal.ts
//
// Hidden CLI verb: `claude-autopilot internal log-phase-event`.
//
// Markdown-driven skills (brainstorm, plan, implement) can't directly import
// the run-state module — they spawn `claude-autopilot` as a subprocess. This
// helper gives them a one-shot way to append a typed event into a known run
// without rewriting the skills as TypeScript modules.
//
// Surface:
//
//   claude-autopilot internal log-phase-event \
//     --run-id 01HZK7... \
//     --event '<json>' \
//     [--cwd /path/to/repo]
//
// `<json>` is the RunEventInput shape (no seq/ts/runId/schema_version/
// writerId — the appender fills those in). Examples:
//
//   --event '{"event":"phase.cost","phase":"plan","phaseIdx":1,
//             "provider":"anthropic","inputTokens":1200,
//             "outputTokens":3400,"costUSD":0.07}'
//
// The verb is HIDDEN — not in HELP_GROUPS, not in HELP_VERBS, not in the
// welcome text. It is documented only via `claude-autopilot internal --help`
// for diagnostics.
//
// Spec: docs/specs/v6-run-state-engine.md "Phase contract" — the markdown
// skills shell out to write events.

import * as path from 'node:path';
import { GuardrailError } from '../errors.ts';
import { appendEvent } from './events.ts';
import { makeWriterId } from './lock.ts';
import { runDirFor } from './runs.ts';
import type { RunEventInput } from './types.ts';

/** Result of a single internal-CLI invocation. The dispatcher in
 *  src/cli/index.ts converts this to an exit code + console output. Pure
 *  data so we can unit-test the dispatch shape without spawning a child. */
export interface RunInternalCliResult {
  /** Process exit code. */
  exit: number;
  /** Lines to print on stdout (text mode only). */
  stdout: string[];
  /** Lines to print on stderr (text mode only). */
  stderr: string[];
}

export interface RunInternalCliOptions {
  /** argv after `claude-autopilot internal`. e.g. ['log-phase-event',
   *  '--run-id', '01HZK', '--event', '{...}']. */
  args: string[];
  /** Working directory containing `.guardrail-cache/runs/`. Defaults to
   *  process.cwd(). */
  cwd?: string;
}

const HELP_TEXT = `
Usage: claude-autopilot internal <verb> [options]

Internal / diagnostic verbs. NOT for end-user use — these are called by
markdown-driven skills (brainstorm, plan, implement) that can't import the
run-state TS module directly. Surface stability is best-effort; do NOT
script against this in user-facing code.

Verbs:
  log-phase-event    Append a typed event to a run's events.ndjson

Options (log-phase-event):
  --run-id <id>      Required. ULID of the run to append to.
  --event <json>     Required. RunEventInput JSON (no seq/ts/runId — those
                     are filled in by the appender).
  --cwd <path>       Optional. Repo root containing .guardrail-cache/runs/.
                     Defaults to the current working directory.

Examples:

  claude-autopilot internal log-phase-event \\
    --run-id 01HZK7XXXXXXXXXXXXXXXXXXXX \\
    --event '{"event":"phase.cost","phase":"plan","phaseIdx":1,
              "provider":"anthropic","inputTokens":1200,
              "outputTokens":3400,"costUSD":0.07}'
`;

/** Parse argv pairs of the form `--name <value>`. Multi-value not supported
 *  here — there is exactly one value per flag. Returns undefined when the
 *  flag is missing, throws when the flag is present but its value is missing
 *  or starts with another `--`. */
function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const val = args[idx + 1];
  if (val === undefined || val.startsWith('--')) {
    throw new GuardrailError(
      `--${name} requires a value`,
      { code: 'user_input', provider: 'cli', details: { flag: name } },
    );
  }
  return val;
}

export async function runInternalCli(
  opts: RunInternalCliOptions,
): Promise<RunInternalCliResult> {
  const args = opts.args;
  const verb = args[0];

  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    return { exit: 0, stdout: [HELP_TEXT.trimStart()], stderr: [] };
  }

  if (verb !== 'log-phase-event') {
    return {
      exit: 1,
      stdout: [],
      stderr: [
        `[claude-autopilot] internal: unknown verb "${verb}"`,
        HELP_TEXT.trimStart(),
      ],
    };
  }

  // log-phase-event
  let runId: string | undefined;
  let eventJson: string | undefined;
  let cwdOverride: string | undefined;
  try {
    runId = readFlag(args, 'run-id');
    eventJson = readFlag(args, 'event');
    cwdOverride = readFlag(args, 'cwd');
  } catch (err) {
    return {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] internal: ${(err as Error).message}`],
    };
  }
  if (!runId) {
    return {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] internal: --run-id is required`],
    };
  }
  if (!eventJson) {
    return {
      exit: 1,
      stdout: [],
      stderr: [`[claude-autopilot] internal: --event is required`],
    };
  }

  let parsed: RunEventInput;
  try {
    parsed = JSON.parse(eventJson) as RunEventInput;
  } catch (err) {
    return {
      exit: 1,
      stdout: [],
      stderr: [
        `[claude-autopilot] internal: --event is not valid JSON: ${(err as Error).message}`,
      ],
    };
  }

  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { event?: unknown }).event !== 'string') {
    return {
      exit: 1,
      stdout: [],
      stderr: [
        `[claude-autopilot] internal: --event must be an object with an "event" string field`,
      ],
    };
  }

  const cwd = cwdOverride ? path.resolve(cwdOverride) : (opts.cwd ?? process.cwd());
  const runDir = runDirFor(cwd, runId);

  // Best-effort writerId. The internal verb does NOT take the run's lock —
  // the markdown skill that calls it is operating "out-of-band" of any
  // currently-held lock by design (skills can't hold a lock across multiple
  // bash invocations). Stamping the writerId of the calling process keeps
  // the event auditable even though it sidesteps the single-writer
  // invariant. Phase 6 may add a `--writer-id <id>` flag for stricter
  // attribution; Phase 2 keeps the surface minimal.
  const writerId = makeWriterId();

  let appended;
  try {
    appended = appendEvent(runDir, parsed, { writerId, runId });
  } catch (err) {
    return {
      exit: 1,
      stdout: [],
      stderr: [
        `[claude-autopilot] internal: appendEvent failed: ${(err as Error).message}`,
      ],
    };
  }

  return {
    exit: 0,
    stdout: [
      `[claude-autopilot] internal: appended seq=${appended.seq} event=${appended.event} runId=${runId}`,
    ],
    stderr: [],
  };
}
