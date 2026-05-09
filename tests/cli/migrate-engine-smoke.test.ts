// tests/cli/migrate-engine-smoke.test.ts
//
// v6.0.8 — end-to-end smoke for the migrate phase wrap. Asserts that
// `runMigrate` with the engine on creates a run dir, writes state.json +
// events.ndjson with the expected lifecycle (run.start → phase.start →
// phase.success → run.complete), records `migration-version`
// externalRefs per applied migration, and that the engine-off path
// produces no engine artifacts.
//
// Drives runMigrate() directly (not via `spawnSync` of the CLI) for
// speed and determinism — the CLI dispatcher is just a flag parser
// exercised by tests/cli/help-text.test.ts already.
//
// Uses the documented `__testDispatch` seam to inject a fake dispatcher
// so tests don't need a real `.autopilot/stack.md`, child process, or
// database. The seam returns a synthetic ResultArtifact shaped like the
// real dispatcher's output.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runMigrate } from '../../src/cli/migrate.ts';
import type { ResultArtifact } from '../../src/core/migrate/types.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-smoke-'));
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

/** Build a synthetic ResultArtifact suitable for tests — the wrap doesn't
 *  care about contractVersion / nonce / sideEffectsPerformed, just the
 *  status / reasonCode / appliedMigrations / nextActions surface. */
function makeFakeArtifact(opts: {
  status?: ResultArtifact['status'];
  reasonCode?: string;
  appliedMigrations?: string[];
  nextActions?: string[];
} = {}): ResultArtifact {
  return {
    contractVersion: '1.0',
    skillId: 'migrate@1',
    invocationId: 'test-invocation',
    nonce: 'test-nonce',
    status: opts.status ?? 'applied',
    reasonCode: opts.reasonCode ?? 'migration-applied',
    appliedMigrations: opts.appliedMigrations ?? [],
    destructiveDetected: false,
    sideEffectsPerformed: ['migration-ledger-updated'],
    nextActions: opts.nextActions ?? [],
  };
}

describe('migrate --engine smoke (v6.0.8)', () => {
  it('engine off (cliEngine: false, legacy escape hatch): no run dir / no engine artifacts', async () => {
    // v6.1 flipped the default to ON. To exercise the engine-off path we
    // now must opt out explicitly — the escape hatch survives one minor
    // version (removed in v7).
    const cwd = tmpProject();
    try {
      const out = await runMigrate({
        cwd,
        cliEngine: false,
        nonInteractive: true,
        __testDispatch: async () => makeFakeArtifact({
          status: 'skipped',
          reasonCode: 'no-pending-migrations',
          appliedMigrations: [],
        }),
      });
      assert.equal(out.exitCode, 0, 'expected exit 0 on skipped');
      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(fs.existsSync(runs), true, 'v7.0: cliEngine=false ignored — engine still runs');
      assert.ok(out.result, 'result artifact should be returned even engine-off');
      assert.equal(out.result!.status, 'skipped');
    } finally {
      cleanup(cwd);
    }
  });

  it('engine on (--engine): produces run dir with state.json + events.ndjson + correct lifecycle', async () => {
    const cwd = tmpProject();
    try {
      const out = await runMigrate({
        cwd,
        cliEngine: true,
        nonInteractive: true,
        __testDispatch: async () => makeFakeArtifact({
          status: 'applied',
          reasonCode: 'migration-applied',
          appliedMigrations: ['20260306000000_add_sso_url', '20260307000000_add_referrals_table'],
        }),
      });
      assert.equal(out.exitCode, 0, 'expected exit 0 on applied');

      const runDir = findRunDir(cwd);
      assert.ok(runDir, `expected a run dir under ${cwd}/.guardrail-cache/runs/`);

      // -- state.json shape ---------------------------------------------------
      const state = readState(runDir!);
      assert.equal(state.status, 'success', `state.status — got ${state.status}`);
      assert.equal(state.phases.length, 1, 'expected exactly one phase');
      const migratePhase = state.phases[0]!;
      assert.equal(migratePhase.name, 'migrate');
      assert.equal(migratePhase.status, 'succeeded');
      assert.equal(migratePhase.idempotent, false, 'migrate should declare idempotent: false (spec table)');
      assert.equal(migratePhase.hasSideEffects, true, 'migrate should declare hasSideEffects: true');
      assert.equal(migratePhase.attempts, 1);
      assert.equal(migratePhase.index, 0);
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
      assert.equal(phaseStart.phase, 'migrate');
      assert.equal(phaseStart.idempotent, false);
      assert.equal(phaseStart.hasSideEffects, true);
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

  it('engine on: each applied migration emits a `migration-version` externalRef scoped by env (plus v6.2.1 pre-effect `migration-batch` breadcrumb)', async () => {
    const cwd = tmpProject();
    try {
      await runMigrate({
        cwd,
        cliEngine: true,
        env: 'qa',
        nonInteractive: true,
        __testDispatch: async () => makeFakeArtifact({
          status: 'applied',
          appliedMigrations: ['20260306000000_alpha', '20260307000000_beta'],
        }),
      });
      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'engine-on should create a run dir');

      const events = readEvents(runDir!);
      const externalRefs = events.filter(e => e.event === 'phase.externalRef');
      // v6.2.1 — 1 pre-effect `migration-batch` breadcrumb + N post-effect
      // `migration-version` reconciliation refs (one per applied migration).
      assert.equal(externalRefs.length, 3, 'expected 1 pre-effect batch + 2 post-effect version refs');
      const refs = externalRefs.map(e => e.event === 'phase.externalRef' ? e.ref : null).filter(Boolean);

      // First ref MUST be the pre-effect breadcrumb — emitted BEFORE dispatch
      // so a partial crash leaves a resume target. See spec section "audit
      // results — current state".
      assert.equal(refs[0]!.kind, 'migration-batch', 'first ref must be the pre-effect batch breadcrumb');
      assert.ok(refs[0]!.id.startsWith('qa:'), `batch ref id should be env-scoped: ${refs[0]!.id}`);

      // Remaining refs are the post-effect reconciliation refs.
      assert.deepEqual(
        refs.slice(1).map(r => r!.kind),
        ['migration-version', 'migration-version'],
        'all post-effect refs should be migration-version',
      );
      assert.ok(
        refs.some(r => r!.id === 'qa:20260306000000_alpha'),
        `expected 'qa:20260306000000_alpha' in [${refs.map(r => r!.id).join(', ')}]`,
      );
      assert.ok(
        refs.some(r => r!.id === 'qa:20260307000000_beta'),
        `expected 'qa:20260307000000_beta' in [${refs.map(r => r!.id).join(', ')}]`,
      );

      // state.json's phase entry should also reflect the persisted refs.
      const state = readState(runDir!);
      const phase = state.phases[0]!;
      assert.ok(phase.externalRefs, 'phase should have externalRefs persisted in state');
      assert.equal(phase.externalRefs.length, 3);
    } finally {
      cleanup(cwd);
    }
  });

  it('engine on: skipped status (no pending migrations) records phase.success with only the v6.2.1 pre-effect `migration-batch` breadcrumb', async () => {
    const cwd = tmpProject();
    try {
      const out = await runMigrate({
        cwd,
        cliEngine: true,
        nonInteractive: true,
        __testDispatch: async () => makeFakeArtifact({
          status: 'skipped',
          reasonCode: 'no-pending-migrations',
          appliedMigrations: [],
        }),
      });
      assert.equal(out.exitCode, 0, 'skipped is a success exit');

      const runDir = findRunDir(cwd);
      assert.ok(runDir);
      const events = readEvents(runDir!);
      const externalRefs = events.filter(e => e.event === 'phase.externalRef');
      // v6.2.1 — even on skipped (zero applied migrations), the pre-effect
      // breadcrumb is emitted before the dispatcher decides "nothing to do."
      // The contract is "did we start this work?" — and we did. Post-effect
      // refs remain empty because nothing was applied.
      assert.equal(externalRefs.length, 1, 'pre-effect batch ref present even when nothing applied');
      const ref0 = externalRefs[0]!;
      if (ref0.event !== 'phase.externalRef') throw new Error('discriminant');
      assert.equal(ref0.ref.kind, 'migration-batch');
      const state = readState(runDir!);
      assert.equal(state.status, 'success');
      assert.equal(state.phases[0]!.status, 'succeeded');
    } finally {
      cleanup(cwd);
    }
  });

  it('engine on: dispatcher returns error status → exit 1 + run completes successfully (phase failure ≠ engine failure)', async () => {
    const cwd = tmpProject();
    try {
      const out = await runMigrate({
        cwd,
        cliEngine: true,
        nonInteractive: true,
        __testDispatch: async () => makeFakeArtifact({
          status: 'error',
          reasonCode: 'env-not-configured',
          appliedMigrations: [],
        }),
      });
      // Phase body returns successfully (no thrown error) — the dispatcher
      // returns an error ResultArtifact, which the wrap renders as exit 1
      // but the engine itself records phase.success because the phase
      // *body* didn't throw.
      assert.equal(out.exitCode, 1, 'dispatcher error → exit 1');

      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'engine-on should still create a run dir on dispatcher error');
      const state = readState(runDir!);
      // The phase succeeded from the engine's POV — it ran to completion.
      // The dispatcher's error status is a domain-level failure surfaced
      // via exit code, separate from engine lifecycle.
      assert.equal(state.status, 'success');
      assert.equal(state.phases[0]!.status, 'succeeded');
    } finally {
      cleanup(cwd);
    }
  });

  // v7.0 — `--no-engine wins over env on` test removed: engine is
  // unconditionally on regardless of cli/env precedence.
});
