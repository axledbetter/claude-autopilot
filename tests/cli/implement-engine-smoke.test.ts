// tests/cli/implement-engine-smoke.test.ts
//
// v6.0.7 — end-to-end smoke for the implement phase wrap. Asserts that
// `runImplement` with the engine on creates a run dir, writes state.json +
// events.ndjson with the expected lifecycle (run.start → phase.start →
// phase.success → run.complete), and that the engine-off path produces
// no engine artifacts.
//
// Drives runImplement() directly (not via `spawnSync` of the CLI) for
// speed and determinism — the CLI dispatcher is just a flag parser
// exercised by tests/cli/help-text.test.ts already.
//
// Implement is a pure local-filesystem verb in v6.0.7: no LLM key, no
// provider, no test seam needed. The actual implementation work (read
// plan, dispatch subagents, write code, run tests, commit, push) is
// produced by the Claude Code `claude-autopilot` skill. The CLI verb
// writes an implement log stub which the engine path checkpoints as
// `result`. See the long deviation note in src/cli/implement.ts for
// the idempotent / hasSideEffects / git-remote-push declaration
// rationale.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runImplement } from '../../src/cli/implement.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'implement-smoke-'));
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

describe('implement --engine smoke (v6.0.7)', () => {
  it('engine off (default): no run dir / no engine artifacts; implement log written', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runImplement({ cwd });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(
        fs.existsSync(runs),
        false,
        `engine-off path should not create ${runs} — got dir`,
      );
      // The implement-log stub is the verb's output regardless of engine state.
      const implementDir = path.join(cwd, '.guardrail-cache', 'implement');
      assert.ok(fs.existsSync(implementDir), 'implement log dir should exist');
      const implementLogs = fs.readdirSync(implementDir);
      assert.equal(implementLogs.length, 1, 'expected exactly one implement log');
      assert.ok(implementLogs[0]!.endsWith('-implement.md'));
    } finally {
      cleanup(cwd);
    }
  });

  it('engine off (cliEngine: false): no run dir / no engine artifacts', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runImplement({ cwd, cliEngine: false });
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
      const exit = await runImplement({ cwd, cliEngine: true });
      assert.equal(exit, 0);

      const runDir = findRunDir(cwd);
      assert.ok(runDir, `expected a run dir under ${cwd}/.guardrail-cache/runs/`);

      // -- state.json shape ---------------------------------------------------
      const state = readState(runDir!);
      assert.equal(state.status, 'success', `state.status — got ${state.status}`);
      assert.equal(state.phases.length, 1, 'expected exactly one phase');
      const implementPhase = state.phases[0]!;
      assert.equal(implementPhase.name, 'implement');
      assert.equal(implementPhase.status, 'succeeded');
      assert.equal(
        implementPhase.idempotent,
        true,
        'implement should declare idempotent: true (deviation from spec table — see implement.ts)',
      );
      assert.equal(
        implementPhase.hasSideEffects,
        false,
        'implement should declare hasSideEffects: false in v6.0.7 (engine-wrap shell only — no git push)',
      );
      assert.equal(implementPhase.attempts, 1);
      assert.equal(implementPhase.index, 0);
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
      assert.equal(phaseStart.phase, 'implement');
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

  it('engine on with explicit context + plan: implement log includes both', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runImplement({
        cwd,
        cliEngine: true,
        context: 'PR #789 — cohort migration',
        plan: 'docs/plans/2026-05-05-cohort.md',
      });
      assert.equal(exit, 0);
      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'engine-on with context should create a run dir');
      const implementDir = path.join(cwd, '.guardrail-cache', 'implement');
      const implementFile = fs.readdirSync(implementDir)[0]!;
      const content = fs.readFileSync(path.join(implementDir, implementFile), 'utf8');
      assert.ok(
        content.includes('PR #789 — cohort migration'),
        `implement log should include the context. Got:\n${content}`,
      );
      assert.ok(
        content.includes('docs/plans/2026-05-05-cohort.md'),
        `implement log should include the plan path. Got:\n${content}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it('engine resolved via env (CLAUDE_AUTOPILOT_ENGINE=on) without CLI flag', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runImplement({ cwd, envEngine: 'on' });
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
      const exit = await runImplement({ cwd, cliEngine: false, envEngine: 'on' });
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
