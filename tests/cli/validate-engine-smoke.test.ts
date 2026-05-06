// tests/cli/validate-engine-smoke.test.ts
//
// v6.0.5 — end-to-end smoke for the validate phase wrap. Asserts that
// `runValidate` with the engine on creates a run dir, writes state.json +
// events.ndjson with the expected lifecycle (run.start → phase.start →
// phase.success → run.complete), and that the engine-off path produces
// no engine artifacts.
//
// Drives runValidate() directly (not via `spawnSync` of the CLI) for
// speed and determinism — the CLI dispatcher is just a flag parser
// exercised by tests/cli/help-text.test.ts already.
//
// Validate is a pure local-filesystem verb in v6.0.5: no LLM key, no
// provider, no test seam needed. The actual validation work (static
// checks, auto-fix, tests, Codex review, bugbot triage) is produced by
// the Claude Code `/validate` skill. The CLI verb writes a validate log
// stub which the engine path checkpoints as `result`. SARIF emission
// lives in `claude-autopilot run --format sarif --output <path>` (a
// separate verb) — see the long deviation note in src/cli/validate.ts
// for the externalRefs / sarif-artifact declaration rationale.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runValidate } from '../../src/cli/validate.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-smoke-'));
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

describe('validate --engine smoke (v6.0.5)', () => {
  it('engine off (default): no run dir / no engine artifacts; validate log written', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runValidate({ cwd });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(
        fs.existsSync(runs),
        false,
        `engine-off path should not create ${runs} — got dir`,
      );
      // The validate-log stub is the verb's output regardless of engine state.
      const validateDir = path.join(cwd, '.guardrail-cache', 'validate');
      assert.ok(fs.existsSync(validateDir), 'validate log dir should exist');
      const validateLogs = fs.readdirSync(validateDir);
      assert.equal(validateLogs.length, 1, 'expected exactly one validate log');
      assert.ok(validateLogs[0]!.endsWith('-validate.md'));
    } finally {
      cleanup(cwd);
    }
  });

  it('engine off (cliEngine: false): no run dir / no engine artifacts', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runValidate({ cwd, cliEngine: false });
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
      const exit = await runValidate({ cwd, cliEngine: true });
      assert.equal(exit, 0);

      const runDir = findRunDir(cwd);
      assert.ok(runDir, `expected a run dir under ${cwd}/.guardrail-cache/runs/`);

      // -- state.json shape ---------------------------------------------------
      const state = readState(runDir!);
      assert.equal(state.status, 'success', `state.status — got ${state.status}`);
      assert.equal(state.phases.length, 1, 'expected exactly one phase');
      const validatePhase = state.phases[0]!;
      assert.equal(validatePhase.name, 'validate');
      assert.equal(validatePhase.status, 'succeeded');
      assert.equal(validatePhase.idempotent, true, 'validate should declare idempotent: true');
      assert.equal(validatePhase.hasSideEffects, false, 'validate should declare hasSideEffects: false (sarif-artifact deviation noted in validate.ts)');
      assert.equal(validatePhase.attempts, 1);
      assert.equal(validatePhase.index, 0);
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
      assert.equal(phaseStart.phase, 'validate');
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

  it('engine on with explicit context: validate log includes the context note', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runValidate({ cwd, cliEngine: true, context: 'PR #456 — pre-merge gate' });
      assert.equal(exit, 0);
      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'engine-on with context should create a run dir');
      const validateDir = path.join(cwd, '.guardrail-cache', 'validate');
      const validateFile = fs.readdirSync(validateDir)[0]!;
      const content = fs.readFileSync(path.join(validateDir, validateFile), 'utf8');
      assert.ok(
        content.includes('PR #456 — pre-merge gate'),
        `validate log should include the context. Got:\n${content}`,
      );
    } finally {
      cleanup(cwd);
    }
  });

  it('engine resolved via env (CLAUDE_AUTOPILOT_ENGINE=on) without CLI flag', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runValidate({ cwd, envEngine: 'on' });
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
      const exit = await runValidate({ cwd, cliEngine: false, envEngine: 'on' });
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
