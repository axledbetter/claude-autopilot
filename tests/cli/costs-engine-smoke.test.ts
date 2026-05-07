// tests/cli/costs-engine-smoke.test.ts
//
// v6.0.2 — end-to-end smoke for the costs phase wrap. Asserts that
// `runCosts` with the engine on creates a run dir, writes state.json +
// events.ndjson with the expected lifecycle (run.start → phase.start →
// phase.success → run.complete), and that the engine-off path produces
// no engine artifacts.
//
// Drives runCosts() directly (not via `spawnSync` of the CLI) for speed
// and determinism — the CLI dispatcher is just a flag parser exercised
// by tests/cli/help-text.test.ts already.
//
// Costs is read-only: no LLM key, no provider, no test seam needed. We
// seed a real cost-ledger file via `appendCostLog` so the phase has
// data to read; the engine-off and engine-on paths both consume it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCosts } from '../../src/cli/costs.ts';
import { appendCostLog } from '../../src/core/persist/cost-log.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';

function tmpProject(seedLedger = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'costs-smoke-'));
  if (seedLedger) {
    appendCostLog(dir, {
      timestamp: new Date().toISOString(),
      files: 5,
      inputTokens: 1200,
      outputTokens: 300,
      costUSD: 0.0045,
      durationMs: 1800,
    });
    appendCostLog(dir, {
      timestamp: new Date().toISOString(),
      files: 3,
      inputTokens: 600,
      outputTokens: 100,
      costUSD: 0.002,
      durationMs: 900,
    });
  }
  return dir;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
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

describe('costs --engine smoke (v6.0.2)', () => {
  it('back-compat string-arg form: runCosts(cwd) still resolves (v6.1: engine on by default)', async () => {
    // Bare-string call form (the legacy `runCosts(cwd)` shape used by
    // tests/costs.test.ts and the MCP handlers). Must remain supported.
    // v6.1 flipped the default to ON, so the string-arg path now creates a
    // run dir as well — but the call signature must keep working.
    const cwd = tmpProject();
    try {
      const exit = await runCosts(cwd);
      assert.equal(exit, 0);
    } finally {
      cleanup(cwd);
    }
  });

  it('engine off (cliEngine: false): no run dir / no engine artifacts', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runCosts({ cwd, cliEngine: false });
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
      const exit = await runCosts({ cwd, cliEngine: true });
      assert.equal(exit, 0);

      const runDir = findRunDir(cwd);
      assert.ok(runDir, `expected a run dir under ${cwd}/.guardrail-cache/runs/`);

      // -- state.json shape ---------------------------------------------------
      const state = readState(runDir!);
      assert.equal(state.status, 'success', `state.status — got ${state.status}`);
      assert.equal(state.phases.length, 1, 'expected exactly one phase');
      const costsPhase = state.phases[0]!;
      assert.equal(costsPhase.name, 'costs');
      assert.equal(costsPhase.status, 'succeeded');
      assert.equal(costsPhase.idempotent, true, 'costs should declare idempotent: true');
      assert.equal(costsPhase.hasSideEffects, false, 'costs should declare hasSideEffects: false');
      assert.equal(costsPhase.attempts, 1);
      assert.equal(costsPhase.index, 0);
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
      assert.equal(phaseStart.phase, 'costs');
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

  it('engine on with empty ledger: still succeeds + creates run dir', async () => {
    const cwd = tmpProject(/*seedLedger=*/false);
    try {
      const exit = await runCosts({ cwd, cliEngine: true });
      assert.equal(exit, 0);
      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'engine-on with empty ledger should still create a run dir');
      const state = readState(runDir!);
      assert.equal(state.status, 'success');
      assert.equal(state.phases[0]!.status, 'succeeded');
    } finally {
      cleanup(cwd);
    }
  });

  it('engine resolved via env (CLAUDE_AUTOPILOT_ENGINE=on) without CLI flag', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runCosts({ cwd, envEngine: 'on' });
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
      const exit = await runCosts({ cwd, cliEngine: false, envEngine: 'on' });
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
