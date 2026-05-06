// tests/cli/scan-engine-smoke.test.ts
//
// v6.0.1 Part A — end-to-end smoke for the scan pilot phase. Asserts that
// `runScan` with the engine on creates a run dir, writes state.json +
// events.ndjson with the expected lifecycle (run.start → phase.start →
// phase.success → run.complete), and that the engine-off path produces no
// engine artifacts.
//
// Drives runScan() directly (not via `spawnSync` of the CLI) to keep the
// test fast and deterministic — the CLI dispatcher is just a flag parser
// + thin pass-through, exercised by tests/cli/help-text.test.ts already.
//
// We inject a fake ReviewEngine via the documented `__testReviewEngine` test
// seam so we don't need an LLM API key in the environment.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runScan } from '../../src/cli/scan.ts';
import type { ReviewEngine, ReviewOutput } from '../../src/adapters/review-engine/types.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-smoke-'));
  // Add at least one code file so scan has something to chew on.
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x = 1;\n');
  return dir;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** A no-cost fake — returns zero findings, zero usage. Lets us assert the
 *  shape of the run dir without real LLM noise. */
function makeFakeEngine(): ReviewEngine {
  const out: ReviewOutput = {
    findings: [],
    rawOutput: '## Findings\nNone.\n',
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

describe('scan --engine smoke (v6.0.1 Part A)', () => {
  it('engine off: no run dir / no engine artifacts', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runScan({
        cwd,
        targets: ['src/'],
        cliEngine: false,
        __testReviewEngine: makeFakeEngine(),
      });
      assert.equal(exit, 0, 'expected scan to exit 0 with zero findings');
      // No .guardrail-cache/runs/ directory should be produced.
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

  it('engine on (--engine): produces run dir with state.json + events.ndjson + correct lifecycle', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runScan({
        cwd,
        targets: ['src/'],
        cliEngine: true,
        __testReviewEngine: makeFakeEngine(),
      });
      assert.equal(exit, 0, 'expected scan to exit 0 with zero findings');

      const runDir = findRunDir(cwd);
      assert.ok(runDir, `expected a run dir under ${cwd}/.guardrail-cache/runs/`);

      // -- state.json shape ---------------------------------------------------
      const state = readState(runDir!);
      assert.equal(state.status, 'success', `state.status — got ${state.status}`);
      assert.equal(state.phases.length, 1, 'expected exactly one phase');
      const scanPhase = state.phases[0]!;
      assert.equal(scanPhase.name, 'scan');
      assert.equal(scanPhase.status, 'succeeded');
      assert.equal(scanPhase.idempotent, true, 'scan should declare idempotent: true');
      assert.equal(scanPhase.hasSideEffects, false, 'scan should declare hasSideEffects: false');
      assert.equal(scanPhase.attempts, 1);
      assert.equal(scanPhase.index, 0);
      assert.ok(state.runId.length > 0, 'runId should be populated');

      // -- events.ndjson lifecycle -------------------------------------------
      const events = readEvents(runDir!);
      const kinds = events.map(e => e.event);
      // Required minimum lifecycle: run.start → phase.start → phase.success → run.complete.
      assert.ok(kinds.includes('run.start'), `expected run.start in [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('phase.start'), `expected phase.start in [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('phase.success'), `expected phase.success in [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('run.complete'), `expected run.complete in [${kinds.join(', ')}]`);

      const runStart = events.find(e => e.event === 'run.start');
      assert.ok(runStart, 'run.start event present');
      const phaseStart = events.find(e => e.event === 'phase.start');
      assert.ok(phaseStart && phaseStart.event === 'phase.start');
      assert.equal(phaseStart.phase, 'scan');
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
      const exit = await runScan({
        cwd,
        targets: ['src/'],
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
      const exit = await runScan({
        cwd,
        targets: ['src/'],
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

  it('invalid env value falls through and surfaces a run.warning when engine ends up on via config', async () => {
    const cwd = tmpProject();
    fs.writeFileSync(
      path.join(cwd, 'guardrail.config.yaml'),
      'configVersion: 1\nengine:\n  enabled: true\n',
    );
    try {
      const exit = await runScan({
        cwd,
        targets: ['src/'],
        envEngine: 'definitely-not-a-bool',
        __testReviewEngine: makeFakeEngine(),
      });
      assert.equal(exit, 0);
      const runDir = findRunDir(cwd);
      assert.ok(runDir);
      const events = readEvents(runDir!);
      const warnings = events.filter(e => e.event === 'run.warning');
      assert.ok(
        warnings.some(w => /CLAUDE_AUTOPILOT_ENGINE/.test(JSON.stringify(w))),
        `expected a run.warning citing the invalid env value — got ${JSON.stringify(warnings)}`,
      );
    } finally {
      cleanup(cwd);
    }
  });
});
