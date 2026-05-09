// tests/cli/brainstorm-engine-smoke.test.ts
//
// v6.0.3 — end-to-end smoke for the brainstorm phase wrap. Asserts that
// `runBrainstorm` with the engine on creates a run dir, writes state.json +
// events.ndjson with the expected lifecycle (run.start → phase.start →
// phase.success → run.complete), and that the engine-off path produces
// no engine artifacts.
//
// Drives runBrainstorm() directly (not via `spawnSync` of the CLI) for speed
// and determinism — the CLI dispatcher is just a flag parser exercised
// by tests/cli/help-text.test.ts already.
//
// Brainstorm is purely advisory in the CLI: no LLM key, no provider, no
// test seam needed. The phase body returns a static "advisory" payload.
// Tests pass `__silent: true` so the renderer doesn't pollute stdout.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runBrainstorm } from '../../src/cli/brainstorm.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-smoke-'));
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

describe('brainstorm --engine smoke (v6.0.3)', () => {
  it('engine on (v6.1 default): creates a run dir even without --engine', async () => {
    // v6.1+ flipped the built-in default to ON. Bare invocation now
    // produces engine artifacts.
    const cwd = tmpProject();
    try {
      const exit = await runBrainstorm({ cwd, __silent: true });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(fs.existsSync(runs), true, 'v6.1 default = engine on, expected run dir');
    } finally {
      cleanup(cwd);
    }
  });

  it('v7.0: cliEngine=false is now a no-op — engine still on, run dir created', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runBrainstorm({ cwd, cliEngine: false, __silent: true });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(fs.existsSync(runs), true, 'v7.0: cliEngine=false ignored — engine still runs');
    } finally {
      cleanup(cwd);
    }
  });

  it('engine on (--engine): produces run dir with state.json + events.ndjson + correct lifecycle', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runBrainstorm({ cwd, cliEngine: true, __silent: true });
      assert.equal(exit, 0);

      const runDir = findRunDir(cwd);
      assert.ok(runDir, `expected a run dir under ${cwd}/.guardrail-cache/runs/`);

      // -- state.json shape ---------------------------------------------------
      const state = readState(runDir!);
      assert.equal(state.status, 'success', `state.status — got ${state.status}`);
      assert.equal(state.phases.length, 1, 'expected exactly one phase');
      const brainstormPhase = state.phases[0]!;
      assert.equal(brainstormPhase.name, 'brainstorm');
      assert.equal(brainstormPhase.status, 'succeeded');
      assert.equal(
        brainstormPhase.idempotent,
        true,
        'brainstorm should declare idempotent: true (deviation note in src/cli/brainstorm.ts)',
      );
      assert.equal(
        brainstormPhase.hasSideEffects,
        false,
        'brainstorm should declare hasSideEffects: false',
      );
      assert.equal(brainstormPhase.attempts, 1);
      assert.equal(brainstormPhase.index, 0);
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
      assert.equal(phaseStart.phase, 'brainstorm');
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
      const exit = await runBrainstorm({ cwd, envEngine: 'on', __silent: true });
      assert.equal(exit, 0);
      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'env on should also create a run dir');
      const state = readState(runDir!);
      assert.equal(state.status, 'success');
    } finally {
      cleanup(cwd);
    }
  });

  // v7.0 — `--no-engine wins over env on` test removed: engine is
  // unconditionally on regardless of cli/env precedence.
});
