// tests/cli/implement-builder-parity.test.ts
//
// v6.2.0 — builder-extraction parity for `implement` (per spec WARNING #4).
// See `tests/cli/scan-builder-parity.test.ts` for the rationale.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runImplement, buildImplementPhase } from '../../src/cli/implement.ts';
import { runPhaseWithLifecycle } from '../../src/core/run-state/run-phase-with-lifecycle.ts';

interface CaptureResult {
  stdout: string;
  stderr: string;
  events: unknown[];
  exitCode: number;
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'implement-parity-'));
}
function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
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
function normalizeEvent(ev: unknown): unknown {
  if (typeof ev !== 'object' || ev === null) return ev;
  const e = ev as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ts: _ts, runId: _runId, writerId: _writerId, durationMs: _durationMs, ...rest } = e;
  return rest;
}
function normalizeImplementPath(text: string): string {
  return text.replace(/\.guardrail-cache\/implement\/[^\s]+-implement\.md/g, '.guardrail-cache/implement/<TS>-implement.md');
}

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

async function captureRunImplement(cwd: string): Promise<CaptureResult> {
  const cap = await captureConsole(() => runImplement({ cwd, cliEngine: true }));
  return { stdout: cap.stdout, stderr: cap.stderr, events: readEvents(cwd), exitCode: cap.value };
}

async function captureBuilder(cwd: string): Promise<CaptureResult> {
  const cap = await captureConsole(async () => {
    const built = await buildImplementPhase({ cwd, cliEngine: true });
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
  return { stdout: cap.stdout, stderr: cap.stderr, events: readEvents(cwd), exitCode: cap.value };
}

describe('implement builder parity (v6.2.0 spec WARNING #4)', () => {
  it('runImplement and buildImplementPhase + runPhaseWithLifecycle produce identical channels', async () => {
    const cwdA = tmpProject();
    const cwdB = tmpProject();
    try {
      const a = await captureRunImplement(cwdA);
      const b = await captureBuilder(cwdB);

      assert.equal(a.exitCode, b.exitCode, 'exit codes must match');
      assert.equal(
        normalizeImplementPath(a.stdout),
        normalizeImplementPath(b.stdout),
        'stdout must be identical (modulo timestamp in implement path)',
      );
      assert.equal(a.stderr, b.stderr, 'stderr must be byte-for-byte identical');
      assert.equal(a.events.length, b.events.length, 'event count must match');
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
