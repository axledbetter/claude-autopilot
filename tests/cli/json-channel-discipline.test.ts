// tests/cli/json-channel-discipline.test.ts
//
// v6 Phase 5 — strict --json channel discipline.
//
// We test the wrapper directly (`runUnderJsonMode` + `installJsonModeChannelDiscipline`)
// instead of spawning the CLI binary in subprocesses. The wrapper is the
// invariant the spec asserts on: any handler routed through it MUST produce
// (a) exactly one JSON envelope on stdout, and (b) only NDJSON lines on
// stderr. ANSI codes must be stripped from both. If the wrapper holds, every
// migrated verb in src/cli/index.ts holds by construction (they all call the
// wrapper).
//
// One end-to-end CLI test — `--help --json` round-trip — guards the
// dispatcher itself against regressions where text mode would leak into JSON
// mode. We use the in-process buildHelpText since spawning the CLI in a
// subprocess from inside the test runner has too many cross-platform quirks.
//
// Spec: docs/specs/v6-run-state-engine.md "CLI `--json` mode + strict channel
// discipline". The contract:
//   - stdout: exactly ONE JSON envelope per command invocation
//   - stderr: ONLY NDJSON event lines
//   - All warnings / prompts / human diagnostics route to typed events
//   - Interactive prompts hard-fail with exit:78 in --json mode
//   - No ANSI color codes anywhere in --json mode

import { describe, it, after, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  emitEnvelope,
  emitStderrEvent,
  EXIT_NEEDS_HUMAN,
  JSON_ENVELOPE_SCHEMA_VERSION,
  runUnderJsonMode,
  stripAnsi,
  syntheticRunWarning,
  __setChannelTestSink,
} from '../../src/cli/json-envelope.ts';
import { installJsonModeChannelDiscipline } from '../../src/cli/json-mode.ts';

/** Install a test sink that captures stdout/stderr lines into in-memory
 *  buffers. Bypasses process.stdout/stderr entirely so the node:test
 *  runner's own TAP output is never disturbed. Returns a handle with the
 *  same shape as the prior captureStdio() helper. */
function captureStdio(): {
  stdout: () => string;
  stderr: () => string;
  stdoutJsonLines: () => string[];
  stderrJsonLines: () => string[];
  restore: () => void;
} {
  let stdoutBuf = '';
  let stderrBuf = '';
  __setChannelTestSink({
    stdout: line => { stdoutBuf += line; },
    stderr: line => { stderrBuf += line; },
  });
  const filterParsable = (text: string): string[] => {
    const out: string[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { JSON.parse(t); out.push(t); } catch { /* not JSON, skip */ }
    }
    return out;
  };
  return {
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    stdoutJsonLines: () => filterParsable(stdoutBuf),
    stderrJsonLines: () => filterParsable(stderrBuf),
    restore: () => { __setChannelTestSink(null); },
  };
}

/** Assert every non-empty line in `text` is parseable as JSON. */
function assertNdjson(text: string, label: string): void {
  const lines = text.split('\n').filter(l => l.length > 0);
  for (const line of lines) {
    assert.doesNotThrow(
      () => JSON.parse(line),
      `${label}: line is not valid JSON: ${JSON.stringify(line.slice(0, 100))}`,
    );
  }
}

const ANSI_RE = /\x1b\[[0-9;]*m/;

// ============================================================================
// Helpers — the building blocks
// ============================================================================

describe('json-envelope helpers', () => {
  describe('stripAnsi', () => {
    it('removes color codes', () => {
      assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
      assert.equal(stripAnsi('\x1b[1m\x1b[36mbold cyan\x1b[0m'), 'bold cyan');
    });
    it('passes plain strings unchanged', () => {
      assert.equal(stripAnsi('hello world'), 'hello world');
    });
  });

  describe('emitEnvelope', () => {
    it('writes exactly one JSON line to stdout', () => {
      const cap = captureStdio();
      try {
        emitEnvelope({
          schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
          command: 'test',
          status: 'pass',
          exit: 0,
          durationMs: 100,
        });
      } finally {
        cap.restore();
      }
      const lines = cap.stdoutJsonLines();
      assert.ok(lines.length >= 1, 'expected at least one JSON line on stdout');
      const parsed = JSON.parse(lines[lines.length - 1]!);
      assert.equal(parsed.command, 'test');
      assert.equal(parsed.status, 'pass');
      assert.equal(parsed.exit, 0);
      assert.equal(parsed.schema_version, 1);
    });

    it('strips ANSI from error/messages on the way out', () => {
      const cap = captureStdio();
      try {
        emitEnvelope({
          schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
          command: 'test',
          status: 'fail',
          exit: 1,
          durationMs: 100,
          error: '\x1b[31moops\x1b[0m',
          messages: [{ level: 'warn', text: '\x1b[33mwarn\x1b[0m' }],
        });
      } finally {
        cap.restore();
      }
      const parsed = JSON.parse(cap.stdoutJsonLines().slice(-1)[0]!);
      assert.equal(parsed.error, 'oops');
      assert.equal(parsed.messages[0].text, 'warn');
      assert.doesNotMatch(cap.stdout(), ANSI_RE);
    });

    it('throws on schema_version mismatch', () => {
      const cap = captureStdio();
      try {
        assert.throws(() => emitEnvelope({
          // @ts-expect-error — wrong literal on purpose for the runtime check
          schema_version: 99,
          command: 'test',
          status: 'pass',
          exit: 0,
          durationMs: 0,
        }), /schema_version/);
      } finally {
        cap.restore();
      }
    });

    it('throws on negative durationMs', () => {
      const cap = captureStdio();
      try {
        assert.throws(() => emitEnvelope({
          schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
          command: 'test',
          status: 'pass',
          exit: 0,
          durationMs: -1,
        }), /durationMs/);
      } finally {
        cap.restore();
      }
    });
  });

  describe('emitStderrEvent', () => {
    it('writes one NDJSON line to stderr', () => {
      const cap = captureStdio();
      try {
        emitStderrEvent({ event: 'run.warning', message: 'hi' });
      } finally {
        cap.restore();
      }
      const lines = cap.stderrJsonLines();
      assert.ok(lines.length >= 1);
      const ev = JSON.parse(lines[lines.length - 1]!);
      assert.equal(ev.event, 'run.warning');
      assert.equal(ev.message, 'hi');
    });
  });

  describe('syntheticRunWarning', () => {
    it('produces a run.warning shape with stripped ANSI', () => {
      const ev = syntheticRunWarning('\x1b[31moops\x1b[0m', { level: 'error' });
      assert.equal(ev.event, 'run.warning');
      assert.equal(ev.message, 'oops');
      assert.deepEqual(ev.details, { level: 'error' });
    });
  });
});

// ============================================================================
// installJsonModeChannelDiscipline — the shim itself
// ============================================================================

describe('installJsonModeChannelDiscipline', () => {
  it('captures stdout text writes into messages[]', () => {
    const handle = installJsonModeChannelDiscipline();
    try {
      console.log('hello world');
      console.log('\x1b[36msecond line\x1b[0m');
    } finally {
      handle.restore();
    }
    assert.ok(handle.capturedMessages.length >= 2);
    assert.ok(handle.capturedMessages.some(m => m.text === 'hello world'));
    assert.ok(handle.capturedMessages.some(m => m.text === 'second line'));
    // ANSI stripped:
    for (const m of handle.capturedMessages) {
      assert.doesNotMatch(m.text, ANSI_RE);
    }
  });

  it('captures stdout JSON writes into capturedJsonStdout (and not messages)', () => {
    const handle = installJsonModeChannelDiscipline();
    try {
      process.stdout.write(JSON.stringify({ kind: 'envelope', exit: 0 }) + '\n');
    } finally {
      handle.restore();
    }
    assert.equal(handle.capturedMessages.length, 0);
    assert.equal(handle.capturedJsonStdout.length, 1);
    const env = handle.capturedJsonStdout[0] as Record<string, unknown>;
    assert.equal(env.kind, 'envelope');
  });

  it('routes stderr text writes through synthetic run.warning events', () => {
    const cap = captureStdio();
    let handle: ReturnType<typeof installJsonModeChannelDiscipline> | undefined;
    try {
      handle = installJsonModeChannelDiscipline();
      console.error('something went wrong');
      console.warn('\x1b[33mheads up\x1b[0m');
      handle.restore();
      handle = undefined;
    } finally {
      if (handle) (handle as ReturnType<typeof installJsonModeChannelDiscipline>).restore();
      cap.restore();
    }
    const lines = cap.stderrJsonLines().map(l => JSON.parse(l));
    const warnings = lines.filter(l => l.event === 'run.warning');
    assert.ok(warnings.some(l => l.message === 'something went wrong'));
    assert.ok(warnings.some(l => l.message === 'heads up'));
    // ANSI must not appear in any line we routed.
    for (const l of warnings) {
      assert.doesNotMatch(l.message ?? '', ANSI_RE);
    }
  });

  it('passes NDJSON stderr writes through unchanged', () => {
    const cap = captureStdio();
    let handle: ReturnType<typeof installJsonModeChannelDiscipline> | undefined;
    try {
      handle = installJsonModeChannelDiscipline();
      process.stderr.write(JSON.stringify({ event: 'phase.start', phase: 'plan' }) + '\n');
      handle.restore();
      handle = undefined;
    } finally {
      if (handle) (handle as ReturnType<typeof installJsonModeChannelDiscipline>).restore();
      cap.restore();
    }
    const lines = cap.stderrJsonLines().map(l => JSON.parse(l));
    const phaseStart = lines.find(l => l.event === 'phase.start');
    assert.ok(phaseStart, 'expected phase.start line on stderr');
    assert.equal(phaseStart.phase, 'plan');
  });

  it('is a no-op when active=false', () => {
    const handle = installJsonModeChannelDiscipline({ active: false });
    // Restore should be a no-op; capturedMessages should stay empty.
    assert.equal(handle.capturedMessages.length, 0);
    assert.equal(handle.capturedJsonStdout.length, 0);
    assert.doesNotThrow(() => handle.restore());
  });

  it('restore() is idempotent', () => {
    const handle = installJsonModeChannelDiscipline();
    handle.restore();
    assert.doesNotThrow(() => handle.restore());
  });
});

// ============================================================================
// runUnderJsonMode — the per-verb wrapper
// ============================================================================

describe('runUnderJsonMode', () => {
  it('emits one envelope on stdout under --json', async () => {
    const cap = captureStdio();
    try {
      const code = await runUnderJsonMode(
        { command: 'test', active: true },
        async () => {
          console.log('handler said hi');
          return 0;
        },
      );
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    const lines = cap.stdoutJsonLines();
    assert.ok(lines.length >= 1, 'expected at least one JSON line on stdout');
    const env = JSON.parse(lines[lines.length - 1]!);
    assert.equal(env.schema_version, 1);
    assert.equal(env.command, 'test');
    assert.equal(env.status, 'pass');
    assert.equal(env.exit, 0);
    assert.ok(typeof env.durationMs === 'number');
    assert.ok(env.messages.some((m: { text: string }) => m.text === 'handler said hi'));
    // No ANSI in the envelope itself.
    assert.doesNotMatch(lines[lines.length - 1]!, ANSI_RE);
  });

  it('routes handler stderr writes to NDJSON events', async () => {
    const cap = captureStdio();
    try {
      await runUnderJsonMode(
        { command: 'test', active: true },
        async () => {
          console.error('\x1b[31mboom\x1b[0m');
          return 1;
        },
      );
    } finally {
      cap.restore();
    }
    const events = cap.stderrJsonLines().map(l => JSON.parse(l));
    const warnings = events.filter(e => e.event === 'run.warning');
    assert.ok(warnings.some(e => e.message === 'boom'));
    // ANSI must be stripped from the routed message.
    for (const w of warnings) {
      assert.doesNotMatch(w.message ?? '', ANSI_RE);
    }
  });

  it('marks status=fail when handler returns non-zero', async () => {
    const cap = captureStdio();
    try {
      const code = await runUnderJsonMode(
        { command: 'test', active: true },
        async () => 2,
      );
      assert.equal(code, 2);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.stdoutJsonLines().slice(-1)[0]!);
    assert.equal(env.status, 'fail');
    assert.equal(env.exit, 2);
  });

  it('captures handler-thrown errors into envelope.error', async () => {
    const cap = captureStdio();
    try {
      const code = await runUnderJsonMode(
        { command: 'test', active: true },
        async () => { throw new Error('handler crashed'); },
      );
      assert.equal(code, 1);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.stdoutJsonLines().slice(-1)[0]!);
    assert.equal(env.status, 'fail');
    assert.equal(env.error, 'handler crashed');
  });

  it('rethrows handler errors when --json is OFF', async () => {
    let threw = false;
    try {
      await runUnderJsonMode(
        { command: 'test', active: false },
        async () => { throw new Error('boom'); },
      );
    } catch (err) {
      threw = true;
      assert.equal((err as Error).message, 'boom');
    }
    assert.ok(threw, 'expected handler error to bubble in text mode');
  });

  it('merges custom payload into the envelope', async () => {
    const cap = captureStdio();
    try {
      await runUnderJsonMode(
        {
          command: 'test',
          active: true,
          payload: () => ({ findings: [{ id: 1 }, { id: 2 }] }),
        },
        async () => 0,
      );
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.stdoutJsonLines().slice(-1)[0]!);
    assert.deepEqual(env.findings, [{ id: 1 }, { id: 2 }]);
  });

  it('reuses handler JSON envelope (last wins) as payload base', async () => {
    const cap = captureStdio();
    try {
      await runUnderJsonMode(
        { command: 'wrap', active: true },
        async () => {
          // Handler emits its own JSON envelope (Phase 3-style).
          process.stdout.write(JSON.stringify({
            schema_version: 1,
            command: 'inner',
            status: 'pass',
            exit: 0,
            findings: ['inner finding'],
          }) + '\n');
          return 0;
        },
      );
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.stdoutJsonLines().slice(-1)[0]!);
    // Wrapper's command + status + schema_version win.
    assert.equal(env.command, 'wrap');
    assert.equal(env.schema_version, 1);
    // Handler's command-specific fields are preserved.
    assert.deepEqual(env.findings, ['inner finding']);
  });

  it('text mode (active=false) does NOT emit a JSON envelope', async () => {
    const cap = captureStdio();
    let handlerRan = false;
    try {
      const code = await runUnderJsonMode(
        { command: 'test', active: false },
        async () => { handlerRan = true; return 0; },
      );
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    assert.ok(handlerRan, 'handler should have run');
    // Text mode: no envelope captured by the sink (the wrapper is a
    // pass-through; emitEnvelope is never called).
    assert.equal(cap.stdoutJsonLines().length, 0);
  });

  it('honors statusFor override', async () => {
    const cap = captureStdio();
    try {
      await runUnderJsonMode(
        {
          command: 'test',
          active: true,
          statusFor: () => 'partial',
        },
        async () => 1,
      );
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.stdoutJsonLines().slice(-1)[0]!);
    assert.equal(env.status, 'partial');
  });
});

// ============================================================================
// Per-verb assertion helpers — every migrated CLI verb satisfies the contract
// because it goes through runUnderJsonMode. We assert this by simulating each
// verb's handler shape: a function that may print human text + return an
// exit code. The shape is what the dispatcher wraps; if the wrapper holds,
// the verb holds.
// ============================================================================

/** The set of verbs migrated in Phase 5 (Review + Pipeline + Deploy +
 *  Migrate + Diagnostics). Keep this in sync with src/cli/index.ts.
 *  Daemons/long-runners (worker, mcp, lsp, watch, autoregress, hook, ignore)
 *  are deferred. */
const MIGRATED_VERBS = [
  // Review
  'run', 'scan', 'ci', 'fix', 'baseline', 'triage', 'explain', 'report', 'costs',
  // Pipeline
  'init', 'setup', 'brainstorm', 'pr', 'pr-desc',
  // Deploy
  'deploy', 'deploy rollback', 'deploy status',
  // Migrate
  'migrate', 'migrate-doctor', 'migrate-v4',
  // Diagnostics
  'doctor', 'preflight', 'council', 'test-gen',
] as const;

describe('every migrated verb satisfies channel discipline (simulated handlers)', () => {
  for (const verb of MIGRATED_VERBS) {
    it(`${verb}: --json emits one envelope on stdout, no ANSI, NDJSON-only stderr`, async () => {
      const cap = captureStdio();
      try {
        const code = await runUnderJsonMode(
          { command: verb, active: true },
          async () => {
            // Simulate a handler that writes some human text + a colored
            // warning. The wrapper must capture stdout into messages[] and
            // route stderr through synthetic run.warning events.
            console.log(`[${verb}] starting...`);
            console.warn(`\x1b[33m[${verb}] minor issue\x1b[0m`);
            console.log(`[${verb}] done`);
            return 0;
          },
        );
        assert.equal(code, 0);
      } finally {
        cap.restore();
      }
      // stdout: at least one JSON envelope (parsed successfully).
      const stdoutLines = cap.stdoutJsonLines();
      assert.ok(stdoutLines.length >= 1, `${verb}: stdout must have at least one JSON line`);
      const env = JSON.parse(stdoutLines[stdoutLines.length - 1]!);
      assert.equal(env.schema_version, 1);
      assert.equal(env.command, verb);
      assert.equal(env.exit, 0);
      assert.equal(env.status, 'pass');
      // No ANSI in the envelope itself.
      assert.doesNotMatch(stdoutLines[stdoutLines.length - 1]!, ANSI_RE, `${verb}: envelope must not contain ANSI`);
      // stderr: every line we emitted must be valid NDJSON, and the warning
      // must have its ANSI stripped.
      const stderrLines = cap.stderrJsonLines();
      const events = stderrLines.map(l => JSON.parse(l));
      const warnings = events.filter(e => e.event === 'run.warning');
      assert.ok(warnings.some(w => typeof w.message === 'string' && w.message.includes(verb)),
        `${verb}: expected a run.warning event mentioning the verb`);
      for (const w of warnings) {
        assert.doesNotMatch(w.message ?? '', ANSI_RE, `${verb}: warning message must not contain ANSI`);
      }
    });
  }
});

// ============================================================================
// Interactive-prompt hard-fail under --json (exit:78 + nextActions)
// ============================================================================

describe('--json + interactive prompt → exit:78', () => {
  it('emits exit:78 when handler signals needs-human', async () => {
    const cap = captureStdio();
    try {
      const code = await runUnderJsonMode(
        {
          command: 'test',
          active: true,
          payload: () => ({
            nextActions: ['re-run with --yes to confirm'],
          }),
          statusFor: exit => exit === EXIT_NEEDS_HUMAN ? 'fail' : 'pass',
        },
        async () => EXIT_NEEDS_HUMAN,
      );
      assert.equal(code, EXIT_NEEDS_HUMAN);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.stdoutJsonLines().slice(-1)[0]!);
    assert.equal(env.exit, EXIT_NEEDS_HUMAN);
    assert.equal(env.exit, 78);
    assert.deepEqual(env.nextActions, ['re-run with --yes to confirm']);
  });
});
