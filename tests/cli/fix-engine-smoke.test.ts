// tests/cli/fix-engine-smoke.test.ts
//
// v6.0.2 — end-to-end smoke for the fix phase wrap. Asserts that
// `runFix` with the engine on creates a run dir, writes state.json +
// events.ndjson with the expected lifecycle (run.start → phase.start →
// phase.success → run.complete), and that the engine-off path produces
// no engine artifacts.
//
// Drives runFix() directly (not via `spawnSync` of the CLI) for speed
// and determinism.
//
// We feed the apply loop a fake ReviewEngine via the documented
// `__testReviewEngine` test seam (mirrors scan). The fake returns
// CANNOT_FIX for every finding so the loop never reaches the readline
// confirmation prompt or the file-write branch — that keeps the smoke
// test deterministic without spawning a TTY.
//
// We also exercise the dry-run path (which short-circuits BEFORE the
// engine route by design — same shape as the legacy v5.x flow). That
// case asserts the engine-off invariant: no run dir is produced.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runFix } from '../../src/cli/fix.ts';
import { saveCachedFindings } from '../../src/core/persist/findings-cache.ts';
import type { Finding } from '../../src/core/findings/types.ts';
import type { ReviewEngine, ReviewOutput } from '../../src/adapters/review-engine/types.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';

/** Seed a tmp project with one source file + one matching cached finding. */
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-smoke-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x = 1;\n');
  const findings: Finding[] = [
    {
      id: 'console-log:src/a.ts:1',
      source: 'static-rules',
      category: 'console-log',
      file: 'src/a.ts',
      line: 1,
      severity: 'critical',
      message: 'placeholder finding for engine smoke',
      protectedPath: false,
      createdAt: '2026-05-05T00:00:00.000Z',
    },
  ];
  saveCachedFindings(dir, findings);
  return dir;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** A no-op fake — every `review` returns `CANNOT_FIX`, so generateFix
 *  returns `cannot_fix` and the apply loop skips the finding without
 *  ever touching readline or the filesystem. */
function makeFakeEngine(): ReviewEngine {
  const out: ReviewOutput = {
    findings: [],
    rawOutput: 'CANNOT_FIX',
    usage: { input: 0, output: 0, costUSD: 0 },
  };
  return {
    name: 'smoke-fake',
    apiVersion: '1.0.0',
    getCapabilities: () => ({}),
    review: async () => out,
    estimateTokens: (s: string) => s.length,
  };
}

function readEvents(runDir: string): RunEvent[] {
  const p = path.join(runDir, 'events.ndjson');
  const raw = fs.readFileSync(p, 'utf8');
  return raw
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as RunEvent);
}

function readState(runDir: string): RunState {
  const p = path.join(runDir, 'state.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as RunState;
}

function findRunDir(cwd: string): string | null {
  const root = path.join(cwd, '.guardrail-cache', 'runs');
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).filter(d => d !== 'index.json');
  if (dirs.length === 0) return null;
  return path.join(root, dirs[0]!);
}

describe('fix --engine smoke (v6.0.2)', () => {
  it('engine off + dry-run: no run dir / no engine artifacts', async () => {
    // Dry-run short-circuits BEFORE the engine route — same shape as the
    // legacy v5.x flow. The engine-off invariant (no run dir) holds.
    const cwd = tmpProject();
    try {
      const exit = await runFix({
        cwd,
        dryRun: true,
        severity: 'all',
      });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(
        fs.existsSync(runs),
        false,
        `engine-off path should not create ${runs} — got dir`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it('engine off (cliEngine: false): apply loop runs but no run dir', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runFix({
        cwd,
        severity: 'all',
        yes: true, // skip readline prompt; fake engine returns CANNOT_FIX so no writes anyway
        cliEngine: false,
        __testReviewEngine: makeFakeEngine(),
      });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(fs.existsSync(runs), false, 'engine-off path should not create run dir');
    } finally {
      cleanup(cwd);
    }
  });

  it('engine on (--engine): produces run dir with state.json + events.ndjson + correct lifecycle', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runFix({
        cwd,
        severity: 'all',
        yes: true,
        cliEngine: true,
        __testReviewEngine: makeFakeEngine(),
      });
      assert.equal(exit, 0, 'expected fix to exit 0 (no failures, all skipped)');

      const runDir = findRunDir(cwd);
      assert.ok(runDir, `expected a run dir under ${cwd}/.guardrail-cache/runs/`);

      // -- state.json shape ---------------------------------------------------
      const state = readState(runDir!);
      assert.equal(state.status, 'success', `state.status — got ${state.status}`);
      assert.equal(state.phases.length, 1, 'expected exactly one phase');
      const fixPhase = state.phases[0]!;
      assert.equal(fixPhase.name, 'fix');
      assert.equal(fixPhase.status, 'succeeded');
      assert.equal(fixPhase.idempotent, true, 'fix should declare idempotent: true');
      assert.equal(fixPhase.hasSideEffects, false, 'fix should declare hasSideEffects: false');
      assert.equal(fixPhase.attempts, 1);
      assert.equal(fixPhase.index, 0);
      assert.ok(state.runId.length > 0, 'runId should be populated');

      // -- events.ndjson lifecycle -------------------------------------------
      const events = readEvents(runDir!);
      const kinds = events.map(e => e.event);
      assert.ok(kinds.includes('run.start'), `expected run.start in [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('phase.start'), `expected phase.start in [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('phase.success'), `expected phase.success in [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('run.complete'), `expected run.complete in [${kinds.join(', ')}]`);

      const phaseStart = events.find(e => e.event === 'phase.start');
      assert.ok(phaseStart && phaseStart.event === 'phase.start');
      assert.equal(phaseStart.phase, 'fix');
      assert.equal(phaseStart.idempotent, true);
      assert.equal(phaseStart.hasSideEffects, false);
      assert.equal(phaseStart.attempt, 1);

      const runComplete = events.find(e => e.event === 'run.complete');
      assert.ok(runComplete && runComplete.event === 'run.complete');
      assert.equal(runComplete.status, 'success');

      // Sequence numbers should be monotonic.
      for (let i = 1; i < events.length; i++) {
        assert.ok(
          events[i]!.seq > events[i - 1]!.seq,
          `events.ndjson seq must be monotonic — got ${events[i - 1]!.seq} then ${events[i]!.seq}`,
        );
      }
    } finally {
      cleanup(cwd);
    }
  });

  it('engine resolved via env (CLAUDE_AUTOPILOT_ENGINE=on) without CLI flag', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runFix({
        cwd,
        severity: 'all',
        yes: true,
        envEngine: 'on',
        __testReviewEngine: makeFakeEngine(),
      });
      assert.equal(exit, 0);
      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'env on should also create a run dir');
      const state = readState(runDir!);
      assert.equal(state.status, 'success');
    } finally {
      cleanup(cwd);
    }
  });

  it('CLI --no-engine wins over env on', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runFix({
        cwd,
        severity: 'all',
        yes: true,
        cliEngine: false,
        envEngine: 'on',
        __testReviewEngine: makeFakeEngine(),
      });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(
        fs.existsSync(runs),
        false,
        '--no-engine must beat env on — no run dir expected',
      );
    } finally {
      cleanup(cwd);
    }
  });
});
