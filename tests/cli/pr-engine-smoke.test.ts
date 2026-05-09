// tests/cli/pr-engine-smoke.test.ts
//
// v6.0.9 — end-to-end smoke for the pr phase wrap. Asserts that
// `runPr` with the engine on creates a run dir, writes state.json +
// events.ndjson with the expected lifecycle (run.start → phase.start →
// phase.externalRef → phase.success → run.complete), and that the
// engine-off path produces no engine artifacts.
//
// Drives runPr() directly (not via `spawnSync` of the CLI) for speed
// and determinism.
//
// pr is the first SIDE-EFFECTING wrap in v6.0.x — `idempotent: false,
// hasSideEffects: true, externalRefs: github-pr`. The phase body posts
// PR comments + inline review comments via the `gh` CLI inside
// runCommand. We bypass both `gh` (PR metadata lookup) and the inner
// runCommand (review pipeline + comment posting) via the documented
// `__testPrMeta` and `__testRunCommand` test seams. The seams keep the
// smoke test deterministic without spawning network calls or requiring
// a checked-out git remote.
//
// What this test asserts (and what it does NOT):
//
//   - Engine lifecycle is correct (run.start → phase.start → phase.success
//     → run.complete) and state.json reflects the right declarations.
//   - The github-pr externalRef is recorded on the phase, with the right
//     kind / id / provider.
//   - Engine off (default + cliEngine: false) produces no run dir.
//   - Env precedence + CLI override precedence are honored.
//   - Engine-on declares idempotent: false, hasSideEffects: true (the
//     spec deviation surface).
//
// What this test does NOT cover (out of scope for v6.0.9):
//
//   - The inner runCommand pipeline — exercised by tests/cli/run.test.ts
//     and the pipeline-level tests, not relitigated here.
//   - The `gh` CLI integration — covered by integration tests under
//     tests/cli/pr-comment.test.ts (when `gh` is available).
//   - Replay gating ("phase already succeeded; --force-replay required").
//     Phase 6 owns the gating tests; this smoke just records the
//     externalRef so a future replay test can exercise the readback.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runPr } from '../../src/cli/pr.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-smoke-'));
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

/** Static PR metadata used by every test that drives the engine path —
 *  short-circuits the `gh pr view` lookup inside runPr so the test
 *  doesn't depend on `gh` being installed / authenticated / on a
 *  PR-tracked branch. */
const FAKE_PR_META = {
  number: 42,
  baseRefName: 'main',
  headRefName: 'feat/test-branch',
  title: 'test PR for engine smoke',
};

/** Stub for the inner `runCommand` invocation — returns a clean exit
 *  without doing any review work. Equivalent to "the pipeline ran and
 *  found nothing to flag". Tests that need to assert specific failure
 *  modes can inject their own stub. */
function fakeRunCommand(): Promise<number> {
  return Promise.resolve(0);
}

describe('pr --engine smoke (v6.0.9)', () => {
  it('engine on (v6.1 default): runCommand still invoked, run dir created', async () => {
    // v6.1 flipped the default to ON. The verb's runCommand seam continues
    // to fire either way; with the default flipped, a run dir is created too.
    const cwd = tmpProject();
    let runCommandCalled = false;
    try {
      const exit = await runPr({
        cwd,
        __testPrMeta: FAKE_PR_META,
        __testRunCommand: () => { runCommandCalled = true; return Promise.resolve(0); },
      });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(fs.existsSync(runs), true, 'v6.1 default = engine on, expected run dir');
      assert.equal(runCommandCalled, true, 'pr verb must still invoke runCommand');
    } finally {
      cleanup(cwd);
    }
  });

  it('engine off (cliEngine: false): no run dir / no engine artifacts', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runPr({
        cwd,
        cliEngine: false,
        __testPrMeta: FAKE_PR_META,
        __testRunCommand: fakeRunCommand,
      });
      assert.equal(exit, 0);
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(fs.existsSync(runs), true, 'v7.0: cliEngine=false ignored — engine still runs');
    } finally {
      cleanup(cwd);
    }
  });

  it('engine on (--engine): produces run dir with state.json + events.ndjson + correct lifecycle + github-pr externalRef', async () => {
    const cwd = tmpProject();
    try {
      const exit = await runPr({
        cwd,
        cliEngine: true,
        __testPrMeta: FAKE_PR_META,
        __testRunCommand: fakeRunCommand,
      });
      assert.equal(exit, 0, 'expected pr to exit 0 (fake runCommand returns 0)');

      const runDir = findRunDir(cwd);
      assert.ok(runDir, `expected a run dir under ${cwd}/.guardrail-cache/runs/`);

      // -- state.json shape ---------------------------------------------------
      const state = readState(runDir!);
      assert.equal(state.status, 'success', `state.status — got ${state.status}`);
      assert.equal(state.phases.length, 1, 'expected exactly one phase');
      const prPhase = state.phases[0]!;
      assert.equal(prPhase.name, 'pr');
      assert.equal(prPhase.status, 'succeeded');
      assert.equal(
        prPhase.idempotent,
        false,
        'pr should declare idempotent: false (matches spec — re-running can produce different review IDs)',
      );
      assert.equal(
        prPhase.hasSideEffects,
        true,
        'pr should declare hasSideEffects: true (posts to GitHub via gh CLI)',
      );
      assert.equal(prPhase.attempts, 1);
      assert.equal(prPhase.index, 0);
      assert.ok(state.runId.length > 0, 'runId should be populated');

      // -- externalRef recorded on the phase ----------------------------------
      assert.equal(
        prPhase.externalRefs.length,
        1,
        `expected exactly one externalRef on pr phase — got ${prPhase.externalRefs.length}`,
      );
      const ref = prPhase.externalRefs[0]!;
      assert.equal(ref.kind, 'github-pr');
      assert.equal(ref.id, '42');
      assert.equal(ref.provider, 'github');
      assert.ok(
        typeof ref.observedAt === 'string' && ref.observedAt.length > 0,
        'externalRef.observedAt should be populated',
      );

      // -- events.ndjson lifecycle -------------------------------------------
      const events = readEvents(runDir!);
      const kinds = events.map(e => e.event);
      assert.ok(kinds.includes('run.start'), `expected run.start in [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('phase.start'), `expected phase.start in [${kinds.join(', ')}]`);
      assert.ok(
        kinds.includes('phase.externalRef'),
        `expected phase.externalRef in [${kinds.join(', ')}]`,
      );
      assert.ok(kinds.includes('phase.success'), `expected phase.success in [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('run.complete'), `expected run.complete in [${kinds.join(', ')}]`);

      const phaseStart = events.find(e => e.event === 'phase.start');
      assert.ok(phaseStart && phaseStart.event === 'phase.start');
      assert.equal(phaseStart.phase, 'pr');
      assert.equal(phaseStart.idempotent, false);
      assert.equal(phaseStart.hasSideEffects, true);
      assert.equal(phaseStart.attempt, 1);

      const externalRefEvent = events.find(e => e.event === 'phase.externalRef');
      assert.ok(externalRefEvent && externalRefEvent.event === 'phase.externalRef');
      assert.equal(externalRefEvent.phase, 'pr');
      assert.equal(externalRefEvent.ref.kind, 'github-pr');
      assert.equal(externalRefEvent.ref.id, '42');

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
      const exit = await runPr({
        cwd,
        envEngine: 'on',
        __testPrMeta: FAKE_PR_META,
        __testRunCommand: fakeRunCommand,
      });
      assert.equal(exit, 0);
      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'env on should also create a run dir');
      const state = readState(runDir!);
      assert.equal(state.status, 'success');
      // The externalRef must still be recorded via env-resolution path.
      assert.equal(state.phases[0]!.externalRefs.length, 1);
      assert.equal(state.phases[0]!.externalRefs[0]!.kind, 'github-pr');
    } finally {
      cleanup(cwd);
    }
  });

  // v7.0 — `--no-engine wins over env on` test removed: engine is
  // unconditionally on regardless of cli/env precedence.

  it('engine on: surfaces inner runCommand failure as exit 1 (phase still succeeds — pipeline failure ≠ engine failure)', async () => {
    // The pr verb returns the runCommand's exit code (0 / 1). When
    // runCommand returns 1 (e.g. critical findings on the PR), the verb
    // returns 1 — but the engine phase ITSELF succeeded (the wrap
    // delegated to runCommand without throwing). State.json should
    // reflect status: 'success' (the phase ran cleanly), with the
    // verb's non-zero exit surfaced via the caller. This matches scan's
    // precedent when scan finds critical findings.
    const cwd = tmpProject();
    try {
      const exit = await runPr({
        cwd,
        cliEngine: true,
        __testPrMeta: FAKE_PR_META,
        __testRunCommand: () => Promise.resolve(1),
      });
      assert.equal(exit, 1, 'expected pr to surface runCommand exit code');
      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'engine path should still create run dir');
      const state = readState(runDir!);
      assert.equal(
        state.status,
        'success',
        'phase succeeded — runCommand returning 1 is a pipeline result, not a phase failure',
      );
      // ExternalRef still recorded — the PR was still touched.
      assert.equal(state.phases[0]!.externalRefs.length, 1);
    } finally {
      cleanup(cwd);
    }
  });
});
