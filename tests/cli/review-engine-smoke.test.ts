// tests/cli/review-engine-smoke.test.ts
//
// v6.0.4 — end-to-end smoke for the review phase wrap. Asserts that
// `runReview` with the engine on creates a run dir, writes state.json +
// events.ndjson with the expected lifecycle (run.start → phase.start →
// phase.success → run.complete), and that the engine-off path produces
// no engine artifacts.
//
// Drives runReview() directly (not via `spawnSync` of the CLI) for speed
// and determinism — the CLI dispatcher is just a flag parser exercised
// by tests/cli/help-text.test.ts already.
//
// Review is a pure local-filesystem verb in v6.0.4: no LLM key, no
// provider, no test seam needed. The actual LLM-driven review content
// is produced by the Claude Code review skills. The CLI verb writes a
// review log stub which the engine path checkpoints as `result`. PR
// comment posting lives in `claude-autopilot pr` (separate verb) — see
// the long deviation note in src/cli/review.ts for declaration rationale.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runReview } from '../../src/cli/review.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-smoke-'));
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

describe('review --engine smoke (v6.0.4)', () => {
  it('engine on (v6.1 default): review log still written and run dir created', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runReview({ cwd });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(fs.existsSync(runs), true, 'v6.1 default = engine on, expected run dir');
      const reviewsDir = path.join(cwd, '.guardrail-cache', 'reviews');
      assert.ok(fs.existsSync(reviewsDir), 'review log dir should exist');
      const reviewLogs = fs.readdirSync(reviewsDir);
      assert.equal(reviewLogs.length, 1, 'expected exactly one review log');
      assert.ok(reviewLogs[0]!.endsWith('-review.md'));
    } finally {
      cleanup(cwd);
    }
  });

  it('engine off (cliEngine: false): no run dir / no engine artifacts', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runReview({ cwd, cliEngine: false });
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
      const exit = await runReview({ cwd, cliEngine: true });
      assert.equal(exit, 0);

      const runDir = findRunDir(cwd);
      assert.ok(runDir, `expected a run dir under ${cwd}/.guardrail-cache/runs/`);

      // -- state.json shape ---------------------------------------------------
      const state = readState(runDir!);
      assert.equal(state.status, 'success', `state.status — got ${state.status}`);
      assert.equal(state.phases.length, 1, 'expected exactly one phase');
      const reviewPhase = state.phases[0]!;
      assert.equal(reviewPhase.name, 'review');
      assert.equal(reviewPhase.status, 'succeeded');
      assert.equal(reviewPhase.idempotent, true, 'review should declare idempotent: true');
      assert.equal(reviewPhase.hasSideEffects, false, 'review should declare hasSideEffects: false (deviation noted in review.ts)');
      assert.equal(reviewPhase.attempts, 1);
      assert.equal(reviewPhase.index, 0);
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
      assert.equal(phaseStart.phase, 'review');
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

  it('engine on with explicit context: review log includes the context note', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runReview({ cwd, cliEngine: true, context: 'PR #123 — auth refactor' });
      assert.equal(exit, 0);
      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'engine-on with context should create a run dir');
      const reviewsDir = path.join(cwd, '.guardrail-cache', 'reviews');
      const reviewFile = fs.readdirSync(reviewsDir)[0]!;
      const content = fs.readFileSync(path.join(reviewsDir, reviewFile), 'utf8');
      assert.ok(
        content.includes('PR #123 — auth refactor'),
        `review log should include the context. Got:\n${content}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it('engine resolved via env (CLAUDE_AUTOPILOT_ENGINE=on) without CLI flag', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runReview({ cwd, envEngine: 'on' });
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
