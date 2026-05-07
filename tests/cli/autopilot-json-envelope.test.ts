// tests/cli/autopilot-json-envelope.test.ts
//
// v6.2.2 — `claude-autopilot autopilot --json` envelope tests.
//
// Per spec docs/specs/v6.2.2-json-envelope-and-docs.md "Tests" section, six
// envelope tests cover:
//   1. Successful run produces parseable envelope with expected fields
//   2. Pre-run failure (engine off) → runId: null + errorCode: invalid_config
//      + exitCode: 1
//   3. Mid-pipeline failure → failedAtPhase + failedPhaseName
//   4. --json mode emits NO ANSI codes on stdout
//   5. Stdout purity under stderr load (codex NOTE #6) — exactly one JSON
//      line on stdout while phase events spam stderr
//   6. Single-write latch + uncaughtException handler (codex WARNING #2) —
//      orchestrator throws AFTER envelope is written; uncaughtException
//      observer must see the latch is set, no second envelope emitted
//
// All tests pass `__testInstallProcessHandlers: false` (or use the latch
// directly) to avoid leaking process-level handlers into the rest of the
// test suite.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __resetAutopilotEnvelopeLatch,
  __isAutopilotEnvelopeWritten,
  __setChannelTestSink,
  writeAutopilotEnvelope,
  computeAutopilotExitCode,
  AUTOPILOT_ERROR_CODES,
  type AutopilotJsonEnvelope,
} from '../../src/cli/json-envelope.ts';
import { runAutopilotWithJsonEnvelope } from '../../src/cli/autopilot.ts';

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-json-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x = 1;\n');
  return dir;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Capture stdout/stderr through the channel test sink so we never touch
 *  the real process streams (the test runner's TAP output stays clean). */
interface CapturedStdio {
  stdout: () => string;
  stderr: () => string;
  stdoutLines: () => string[];
  restore: () => void;
}

function captureStdio(): CapturedStdio {
  let stdoutBuf = '';
  let stderrBuf = '';
  __setChannelTestSink({
    stdout: line => { stdoutBuf += line; },
    stderr: line => { stderrBuf += line; },
  });
  return {
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    stdoutLines: () =>
      stdoutBuf.split('\n').filter(l => l.length > 0),
    restore: () => { __setChannelTestSink(null); },
  };
}

const ANSI_RE = /\x1b\[[0-9;]*m/;

beforeEach(() => {
  __resetAutopilotEnvelopeLatch();
});

// ============================================================================
// Test 1 — successful run produces parseable envelope with expected fields
// ============================================================================

describe('autopilot --json — successful run envelope', () => {
  it('emits one parseable envelope with the spec-defined fields', async () => {
    const cwd = tmpProject();
    const cap = captureStdio();
    try {
      const exit = await runAutopilotWithJsonEnvelope({
        cwd,
        phases: ['spec', 'plan', 'implement'],
        __testInstallProcessHandlers: false,
      });

      assert.equal(exit, 0, `expected exit 0, got ${exit}`);

      const lines = cap.stdoutLines();
      assert.equal(lines.length, 1, `expected exactly one JSON line on stdout, got ${lines.length}`);

      const env = JSON.parse(lines[0]!) as AutopilotJsonEnvelope;
      assert.equal(env.version, '1');
      assert.equal(env.verb, 'autopilot');
      assert.equal(env.status, 'success');
      assert.equal(env.exitCode, 0);
      assert.ok(env.runId, 'runId should be populated for a successful run');
      assert.equal(env.phases.length, 3);
      assert.equal(env.phases[0]!.name, 'spec');
      assert.equal(env.phases[0]!.status, 'success');
      assert.equal(env.phases[1]!.name, 'plan');
      assert.equal(env.phases[2]!.name, 'implement');
      assert.equal(typeof env.totalCostUSD, 'number');
      assert.equal(typeof env.durationMs, 'number');
      assert.ok(env.durationMs >= 0);
      assert.equal(env.errorCode, undefined);
      assert.equal(env.errorMessage, undefined);
    } finally {
      cap.restore();
      cleanup(cwd);
    }
  });
});

// ============================================================================
// Test 2 — pre-run failure (engine off) → runId: null, invalid_config, exit 1
// ============================================================================

describe('autopilot --json — pre-run failure envelope', () => {
  it('engine off → runId: null, errorCode: invalid_config, exitCode: 1', async () => {
    const cwd = tmpProject();
    const cap = captureStdio();
    try {
      const exit = await runAutopilotWithJsonEnvelope({
        cwd,
        envEngine: 'off',
        __testInstallProcessHandlers: false,
      });

      assert.equal(exit, 1);
      const lines = cap.stdoutLines();
      assert.equal(lines.length, 1, 'exactly one envelope on stdout');
      const env = JSON.parse(lines[0]!) as AutopilotJsonEnvelope;
      assert.equal(env.runId, null);
      assert.equal(env.status, 'failed');
      assert.equal(env.exitCode, 1);
      assert.equal(env.errorCode, 'invalid_config');
      assert.equal(env.phases.length, 0);
      assert.equal(env.totalCostUSD, 0);
      assert.ok(env.errorMessage);
      assert.ok(/engine/i.test(env.errorMessage), `errorMessage should mention engine: ${env.errorMessage}`);
    } finally {
      cap.restore();
      cleanup(cwd);
    }
  });
});

// ============================================================================
// Test 3 — mid-pipeline failure → failedAtPhase + failedPhaseName
// ============================================================================

describe('autopilot --json — mid-pipeline failure envelope', () => {
  it('budget cap of $0.01 trips phase 0 → failedAtPhase: 0, failedPhaseName, errorCode: budget_exceeded', async () => {
    const cwd = tmpProject();
    const cap = captureStdio();
    try {
      const exit = await runAutopilotWithJsonEnvelope({
        cwd,
        phases: ['spec', 'plan', 'implement'],
        budgetUSD: 0.01,
        __testInstallProcessHandlers: false,
      });

      assert.equal(exit, 78, 'budget_exceeded maps to exit 78');
      const lines = cap.stdoutLines();
      assert.equal(lines.length, 1, 'exactly one envelope on stdout');
      const env = JSON.parse(lines[0]!) as AutopilotJsonEnvelope;
      assert.equal(env.status, 'failed');
      assert.equal(env.exitCode, 78);
      assert.equal(env.errorCode, 'budget_exceeded');
      assert.equal(env.failedAtPhase, 0, 'first phase failed');
      assert.equal(env.failedPhaseName, 'spec');
      assert.ok(env.runId, 'runId should be populated for a started run');
    } finally {
      cap.restore();
      cleanup(cwd);
    }
  });
});

// ============================================================================
// Test 4 — --json mode emits NO ANSI codes on stdout
// ============================================================================

describe('autopilot --json — no ANSI codes on stdout', () => {
  it('stdout has no ANSI escape sequences even when error path interpolates them', async () => {
    const cwd = tmpProject();
    const cap = captureStdio();
    try {
      // Engine-off path interpolates ANSI codes into stderr text in legacy
      // mode; in JSON mode the orchestrator runs __silent and the envelope
      // path strips ANSI defensively from errorMessage.
      await runAutopilotWithJsonEnvelope({
        cwd,
        envEngine: 'off',
        __testInstallProcessHandlers: false,
      });
      const stdout = cap.stdout();
      assert.equal(
        ANSI_RE.test(stdout),
        false,
        `stdout must not contain ANSI codes: ${JSON.stringify(stdout.slice(0, 200))}`,
      );
      // The successful path: also verify ANSI strip on a successful run.
      const cwd2 = tmpProject();
      __resetAutopilotEnvelopeLatch();
      const cap2 = captureStdio();
      try {
        await runAutopilotWithJsonEnvelope({
          cwd: cwd2,
          phases: ['spec'],
          __testInstallProcessHandlers: false,
        });
        assert.equal(
          ANSI_RE.test(cap2.stdout()),
          false,
          'stdout must not contain ANSI codes on success path',
        );
      } finally {
        cap2.restore();
        cleanup(cwd2);
      }
    } finally {
      cap.restore();
      cleanup(cwd);
    }
  });
});

// ============================================================================
// Test 5 — stdout purity under stderr load (codex NOTE #6)
// ============================================================================

describe('autopilot --json — stdout purity under stderr load', () => {
  it('exactly one JSON line on stdout regardless of stderr volume', async () => {
    const cwd = tmpProject();
    const cap = captureStdio();
    try {
      // Drive the orchestrator with the 3-phase happy path. Each phase
      // emits multiple events on stderr (run.start, phase.start, phase.cost,
      // phase.success, etc.). We assert the stdout invariant holds even
      // with that volume on stderr.
      const exit = await runAutopilotWithJsonEnvelope({
        cwd,
        phases: ['spec', 'plan', 'implement'],
        __testInstallProcessHandlers: false,
      });
      assert.equal(exit, 0);
      // STDOUT must be exactly ONE JSON line — nothing else.
      const stdoutLines = cap.stdoutLines();
      assert.equal(
        stdoutLines.length, 1,
        `stdout must contain exactly one JSON line; got ${stdoutLines.length}: ${stdoutLines.slice(0, 5).join(' | ')}`,
      );
      // And it must be parseable.
      assert.doesNotThrow(() => JSON.parse(stdoutLines[0]!));
    } finally {
      cap.restore();
      cleanup(cwd);
    }
  });
});

// ============================================================================
// Test 6 — single-write latch + uncaughtException handler (codex WARNING #2)
// ============================================================================

describe('autopilot --json — single-write latch', () => {
  it('latch flips before write and prevents subsequent envelope emission', () => {
    const cap = captureStdio();
    try {
      assert.equal(__isAutopilotEnvelopeWritten(), false, 'latch starts unset');
      writeAutopilotEnvelope({
        runId: 'r1',
        status: 'success',
        exitCode: 0,
        phases: [],
        totalCostUSD: 0,
        durationMs: 1,
      });
      assert.equal(__isAutopilotEnvelopeWritten(), true, 'latch is set after first write');
      assert.equal(cap.stdoutLines().length, 1, 'first write produces one envelope');

      // Subsequent calls no-op — exactly the contract the uncaughtException
      // handler relies on so a fatal-after-success doesn't double-emit.
      writeAutopilotEnvelope({
        runId: null,
        status: 'failed',
        exitCode: 1,
        phases: [],
        totalCostUSD: 0,
        durationMs: 1,
        errorCode: 'internal_error',
        errorMessage: 'simulated fatal after envelope',
      });
      assert.equal(cap.stdoutLines().length, 1, 'second write must be a no-op');
    } finally {
      cap.restore();
    }
  });

  it('orchestrator finalization throw after envelope: latch suppresses uncaughtException fallback', async () => {
    // Simulate the exact flow the codex WARNING #2 describes:
    //   1. orchestrator runs to completion
    //   2. envelope written
    //   3. test-injected throw fires (the spec's "finalization error after
    //      the success envelope" path)
    //   4. an uncaughtException-style handler runs, observes the latch is
    //      set, and no-ops without double-emitting.
    //
    // We implement (4) inline via __isAutopilotEnvelopeWritten() rather
    // than installing a real process handler, because that would leak
    // across the suite. The behavior under test is the latch contract,
    // not the process.on plumbing — that's covered by the integration
    // smoke that runAutopilotWithJsonEnvelope exercises elsewhere.
    const cwd = tmpProject();
    const cap = captureStdio();
    let observedWrittenAtCatch = false;
    let secondEnvelopeEmitted = false;
    try {
      try {
        await runAutopilotWithJsonEnvelope({
          cwd,
          phases: ['spec'],
          __testInstallProcessHandlers: false,
          __testThrowAfterEnvelope: () => {
            throw new Error('simulated finalization error');
          },
        });
        assert.fail('expected the test seam to throw');
      } catch (err) {
        // Mirror the uncaughtException handler's logic: consult the latch.
        observedWrittenAtCatch = __isAutopilotEnvelopeWritten();
        if (!observedWrittenAtCatch) {
          // What the real handler would do — but the latch should make
          // this branch unreachable.
          writeAutopilotEnvelope({
            runId: null,
            status: 'failed',
            exitCode: 1,
            phases: [],
            totalCostUSD: 0,
            durationMs: 1,
            errorCode: 'internal_error',
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          secondEnvelopeEmitted = true;
        }
      }
      // The orchestrator's success envelope shipped first; the simulated
      // post-envelope throw observed the latch was already set.
      assert.equal(observedWrittenAtCatch, true, 'latch must be set when the post-envelope throw is caught');
      assert.equal(secondEnvelopeEmitted, false, 'no second envelope should be emitted');
      const lines = cap.stdoutLines();
      assert.equal(lines.length, 1, `exactly one envelope on stdout, got ${lines.length}`);
      const env = JSON.parse(lines[0]!) as AutopilotJsonEnvelope;
      assert.equal(env.status, 'success', 'the surviving envelope is the original success one');
    } finally {
      cap.restore();
      cleanup(cwd);
    }
  });
});

// ============================================================================
// Bonus — exit-code mapping is deterministic per spec table.
// (Sanity test, not part of the spec's six but trivially defensive.)
// ============================================================================

describe('computeAutopilotExitCode — spec mapping', () => {
  it('maps every bounded errorCode to the spec-required exit code', () => {
    assert.equal(computeAutopilotExitCode(undefined), 0);
    assert.equal(computeAutopilotExitCode('invalid_config'), 1);
    assert.equal(computeAutopilotExitCode('phase_failed'), 1);
    assert.equal(computeAutopilotExitCode('internal_error'), 1);
    assert.equal(computeAutopilotExitCode('lock_held'), 2);
    assert.equal(computeAutopilotExitCode('corrupted_state'), 2);
    assert.equal(computeAutopilotExitCode('partial_write'), 2);
    assert.equal(computeAutopilotExitCode('budget_exceeded'), 78);
    assert.equal(computeAutopilotExitCode('needs_human'), 78);
  });

  it('AUTOPILOT_ERROR_CODES has exactly the spec-required members', () => {
    const expected = new Set([
      'invalid_config', 'budget_exceeded', 'lock_held', 'corrupted_state',
      'partial_write', 'needs_human', 'phase_failed', 'internal_error',
    ]);
    assert.equal(AUTOPILOT_ERROR_CODES.length, expected.size);
    for (const code of AUTOPILOT_ERROR_CODES) {
      assert.ok(expected.has(code), `unexpected code: ${code}`);
    }
  });
});
