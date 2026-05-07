// tests/cli/plan-engine-smoke.test.ts
//
// v6.0.4 — end-to-end smoke for the plan phase wrap. Asserts that
// `runPlan` with the engine on creates a run dir, writes state.json +
// events.ndjson with the expected lifecycle (run.start → phase.start →
// phase.success → run.complete), and that the engine-off path produces
// no engine artifacts.
//
// Drives runPlan() directly (not via `spawnSync` of the CLI) for speed
// and determinism — the CLI dispatcher is just a flag parser exercised
// by tests/cli/help-text.test.ts already.
//
// Plan is a pure local-filesystem verb: no LLM key, no provider, no
// test seam needed. The actual LLM-driven planner lives in the Claude
// Code superpowers:writing-plans skill. The CLI verb writes a plan
// markdown stub which the engine path checkpoints as `result`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runPlan } from '../../src/cli/plan.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-smoke-'));
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

describe('plan --engine smoke (v6.0.4)', () => {
  it('engine on (v6.1 default): plan file still written and a run dir is created', async () => {
    // v6.1 flipped the default to ON. The verb still produces its plan
    // file regardless of engine state; with the default flipped, a run dir
    // is also created.
    const cwd = tmpProject();
    try {
      const exit = await runPlan({ cwd });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(fs.existsSync(runs), true, 'v6.1 default = engine on, expected run dir');
      const plansDir = path.join(cwd, '.guardrail-cache', 'plans');
      assert.ok(fs.existsSync(plansDir), 'plan file dir should exist');
      const planFiles = fs.readdirSync(plansDir);
      assert.equal(planFiles.length, 1, 'expected exactly one plan file');
      assert.ok(planFiles[0]!.endsWith('-plan.md'));
    } finally {
      cleanup(cwd);
    }
  });

  it('engine off (cliEngine: false): no run dir / no engine artifacts', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runPlan({ cwd, cliEngine: false });
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
      const exit = await runPlan({ cwd, cliEngine: true });
      assert.equal(exit, 0);

      const runDir = findRunDir(cwd);
      assert.ok(runDir, `expected a run dir under ${cwd}/.guardrail-cache/runs/`);

      // -- state.json shape ---------------------------------------------------
      const state = readState(runDir!);
      assert.equal(state.status, 'success', `state.status — got ${state.status}`);
      assert.equal(state.phases.length, 1, 'expected exactly one phase');
      const planPhase = state.phases[0]!;
      assert.equal(planPhase.name, 'plan');
      assert.equal(planPhase.status, 'succeeded');
      assert.equal(planPhase.idempotent, true, 'plan should declare idempotent: true');
      assert.equal(planPhase.hasSideEffects, false, 'plan should declare hasSideEffects: false');
      assert.equal(planPhase.attempts, 1);
      assert.equal(planPhase.index, 0);
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
      assert.equal(phaseStart.phase, 'plan');
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

  it('engine on with explicit spec path: still succeeds + plan file references the spec', async () => {
    const cwd = tmpProject();
    try {
      // Seed a real spec file the planner can read.
      const specPath = path.join(cwd, 'spec.md');
      fs.writeFileSync(specPath, '# Test spec\n\nSome requirements here.\n', 'utf8');
      const exit = await runPlan({ cwd, cliEngine: true, specPath });
      assert.equal(exit, 0);
      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'engine-on with spec should create a run dir');
      const state = readState(runDir!);
      assert.equal(state.status, 'success');
      // The plan file should reference the spec path.
      const plansDir = path.join(cwd, '.guardrail-cache', 'plans');
      const planFile = fs.readdirSync(plansDir)[0]!;
      const planContent = fs.readFileSync(path.join(plansDir, planFile), 'utf8');
      assert.ok(planContent.includes(specPath), `plan file should include spec path. Got:\n${planContent}`);
    } finally {
      cleanup(cwd);
    }
  });

  it('engine resolved via env (CLAUDE_AUTOPILOT_ENGINE=on) without CLI flag', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runPlan({ cwd, envEngine: 'on' });
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
      const exit = await runPlan({ cwd, cliEngine: false, envEngine: 'on' });
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
