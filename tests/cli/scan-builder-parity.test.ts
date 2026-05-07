// tests/cli/scan-builder-parity.test.ts
//
// v6.2.0 — builder-extraction parity (per spec WARNING #4).
//
// Asserts that `runScan(options)` produces identical stdout / stderr /
// events.ndjson to driving `buildScanPhase` → `runPhaseWithLifecycle`
// directly. The orchestrator (src/cli/autopilot.ts) calls `buildScanPhase`
// instead of `runScan`, so any drift between the two execution shapes
// would silently corrupt the orchestrator's per-phase output.
//
// Test approach:
//   1. Run `runScan(options)` against tmp project A; capture stdout +
//      stderr + events.ndjson.
//   2. Run `buildScanPhase + runPhaseWithLifecycle` against tmp project B
//      with the exact same options; capture the same channels.
//   3. Assert byte-for-byte equality after normalizing volatile fields
//      (timestamps, ULIDs, durationMs, runId) — those vary by clock and
//      can never match cross-run.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runScan, buildScanPhase } from '../../src/cli/scan.ts';
import { runPhaseWithLifecycle } from '../../src/core/run-state/run-phase-with-lifecycle.ts';
import type { ReviewEngine, ReviewOutput } from '../../src/adapters/review-engine/types.ts';

interface CaptureResult {
  stdout: string;
  stderr: string;
  events: unknown[];
  exitCode: number;
}

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-parity-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x = 1;\n');
  return dir;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeFakeEngine(): ReviewEngine {
  const out: ReviewOutput = {
    findings: [],
    rawOutput: '## Findings\nNone.\n',
    usage: { input: 0, output: 0, costUSD: 0 },
  };
  return {
    name: 'parity-fake',
    apiVersion: '1.0.0',
    getCapabilities: () => ({}),
    review: async () => out,
    estimateTokens: (s: string) => s.length,
  };
}

function readEvents(cwd: string): unknown[] {
  const root = path.join(cwd, '.guardrail-cache', 'runs');
  if (!fs.existsSync(root)) return [];
  const dirs = fs.readdirSync(root).filter(d => d !== 'index.json');
  if (dirs.length === 0) return [];
  const runDir = path.join(root, dirs[0]!);
  const events = path.join(runDir, 'events.ndjson');
  if (!fs.existsSync(events)) return [];
  return fs.readFileSync(events, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line));
}

/** Strip volatile fields so two runs against different cwds compare
 *  equal. Timestamps, ULIDs, durations, writerIds, runIds — none of
 *  those can match across separate runs. We DO compare the event
 *  sequence, types, phase metadata, and seq monotonicity. */
function normalizeEvent(ev: unknown): unknown {
  if (typeof ev !== 'object' || ev === null) return ev;
  const e = ev as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ts: _ts, runId: _runId, writerId: _writerId, durationMs: _durationMs, ...rest } = e;
  return rest;
}

/** Capture console.log / console.error output (stdout / stderr respectively).
 *  We don't intercept process.stdout.write directly because the node:test
 *  runner emits its IPC reporter frames through that file descriptor — any
 *  test that captures stdout.write at the FD layer will catch the frames
 *  and produce non-deterministic noise. console.log / console.error route
 *  through process.{stdout,stderr}.write internally but are
 *  monkeypatchable in isolation. */
async function captureConsole<T>(work: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.log = (...args: any[]) => {
    stdoutChunks.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' ') + '\n');
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.error = (...args: any[]) => {
    stderrChunks.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' ') + '\n');
  };
  try {
    const value = await work();
    return { value, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

async function captureRunScan(cwd: string): Promise<CaptureResult> {
  const cap = await captureConsole(() => runScan({
    cwd,
    targets: ['src/'],
    cliEngine: true,
    __testReviewEngine: makeFakeEngine(),
  }));
  const events = readEvents(cwd);
  return {
    stdout: cap.stdout,
    stderr: cap.stderr,
    events,
    exitCode: cap.value,
  };
}

async function captureBuilderPath(cwd: string): Promise<CaptureResult> {
  const cap = await captureConsole(async () => {
    const built = await buildScanPhase({
      cwd,
      targets: ['src/'],
      cliEngine: true,
      __testReviewEngine: makeFakeEngine(),
    });
    if (built.kind === 'early-exit') return built.exitCode;
    try {
      const result = await runPhaseWithLifecycle({
        cwd: built.input.cwd,
        phase: built.phase,
        input: built.input,
        config: built.config,
        cliEngine: true,
        envEngine: undefined,
        runEngineOff: () => built.phase.run(built.input, {} as never),
      });
      return built.renderResult(result.output);
    } catch {
      return 1;
    }
  });
  const events = readEvents(cwd);
  return {
    stdout: cap.stdout,
    stderr: cap.stderr,
    events,
    exitCode: cap.value,
  };
}

describe('scan builder parity (v6.2.0 spec WARNING #4)', () => {
  it('runScan and buildScanPhase + runPhaseWithLifecycle produce identical channels', async () => {
    const cwdA = tmpProject();
    const cwdB = tmpProject();
    try {
      const a = await captureRunScan(cwdA);
      const b = await captureBuilderPath(cwdB);

      assert.equal(a.exitCode, b.exitCode, 'exit codes must match');
      assert.equal(a.stdout, b.stdout, 'stdout must be byte-for-byte identical');
      assert.equal(a.stderr, b.stderr, 'stderr must be byte-for-byte identical');

      // Event sequences should match in count + variant + phase metadata
      // (after stripping the per-run volatile fields).
      assert.equal(
        a.events.length,
        b.events.length,
        `event count mismatch — runScan emitted ${a.events.length}, builder path emitted ${b.events.length}`,
      );
      for (let i = 0; i < a.events.length; i++) {
        assert.deepEqual(
          normalizeEvent(a.events[i]),
          normalizeEvent(b.events[i]),
          `event ${i} diverged between paths`,
        );
      }
    } finally {
      cleanup(cwdA);
      cleanup(cwdB);
    }
  });
});
