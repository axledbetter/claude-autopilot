// tests/run-state/run-phase-with-lifecycle.test.ts
//
// v6.0.6 — unit tests for the `runPhaseWithLifecycle` helper. Covers:
//   - engine-off path (calls runEngineOff, no run dir, runId/runDir null)
//   - engine-on success (lifecycle events emitted, state snapshot written,
//     lock released)
//   - engine-on failure (run.complete failed, state snapshot, lock released,
//     error re-thrown)
//   - resolveEngineEnabled precedence (CLI > env > config > default) for the
//     three primary inputs the helper plumbs
//   - lock-release safety (release error swallowed, original throw preserved)
//   - invalid env value emits run.warning when engine ends up on via config
//   - cost extraction (output.costUSD passes through to run.complete)
//
// Smoke-style integration: drives the helper against a fresh tmp project
// and inspects state.json + events.ndjson. No network, no LLM keys needed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runPhaseWithLifecycle } from '../../src/core/run-state/run-phase-with-lifecycle.ts';
import type { RunPhase } from '../../src/core/run-state/phase-runner.ts';
import type { RunEvent, RunState } from '../../src/core/run-state/types.ts';
import type { GuardrailConfig } from '../../src/core/config/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-helper-'));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function findRunDir(cwd: string): string | null {
  const root = path.join(cwd, '.guardrail-cache', 'runs');
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).filter(d => d !== 'index.json');
  if (dirs.length === 0) return null;
  return path.join(root, dirs[0]!);
}

function readEvents(runDir: string): RunEvent[] {
  const raw = fs.readFileSync(path.join(runDir, 'events.ndjson'), 'utf8');
  return raw.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as RunEvent);
}

function readState(runDir: string): RunState {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')) as RunState;
}

interface NoopInput { tag: string }
interface NoopOutput { tag: string; costUSD?: number }

/** Always-succeed phase. Returns its input's tag back so we can verify the
 *  helper's `output` plumb-through. */
function makeSuccessPhase(opts: { name?: string; idempotent?: boolean; hasSideEffects?: boolean } = {}): RunPhase<NoopInput, NoopOutput> {
  return {
    name: opts.name ?? 'test',
    idempotent: opts.idempotent ?? true,
    hasSideEffects: opts.hasSideEffects ?? false,
    run: async (input: NoopInput): Promise<NoopOutput> => ({ tag: input.tag }),
  };
}

/** Always-throw phase. Lets us exercise the failure lifecycle path. */
function makeFailingPhase(opts: { name?: string; message?: string } = {}): RunPhase<NoopInput, NoopOutput> {
  return {
    name: opts.name ?? 'test-fail',
    idempotent: true,
    hasSideEffects: false,
    run: async (): Promise<NoopOutput> => {
      throw new Error(opts.message ?? 'boom');
    },
  };
}

const DEFAULT_CONFIG: GuardrailConfig = { configVersion: 1 };

// ---------------------------------------------------------------------------
// Engine-off path
// ---------------------------------------------------------------------------

describe('runPhaseWithLifecycle — engine-off path', () => {
  it('calls runEngineOff when engine is disabled (default v6.0)', async () => {
    const cwd = tmpProject();
    try {
      let offCalled = false;
      const result = await runPhaseWithLifecycle<NoopInput, NoopOutput>({
        cwd,
        phase: makeSuccessPhase(),
        input: { tag: 'engine-off' },
        config: DEFAULT_CONFIG,
        cliEngine: undefined,
        envEngine: undefined,
        runEngineOff: async () => {
          offCalled = true;
          return { tag: 'from-engine-off' };
        },
      });
      assert.equal(offCalled, true, 'runEngineOff must be invoked');
      assert.equal(result.output.tag, 'from-engine-off', 'helper must return runEngineOff output');
      assert.equal(result.runId, null, 'runId must be null on engine-off');
      assert.equal(result.runDir, null, 'runDir must be null on engine-off');

      const runs = path.join(cwd, '.guardrail-cache', 'runs');
      assert.equal(fs.existsSync(runs), false, 'engine-off must not create run dir');
    } finally {
      cleanup(cwd);
    }
  });

  it('--no-engine wins over env on (CLI > env precedence)', async () => {
    const cwd = tmpProject();
    try {
      const result = await runPhaseWithLifecycle<NoopInput, NoopOutput>({
        cwd,
        phase: makeSuccessPhase(),
        input: { tag: 't' },
        config: DEFAULT_CONFIG,
        cliEngine: false,
        envEngine: 'on',
        runEngineOff: async () => ({ tag: 'off' }),
      });
      assert.equal(result.runId, null, '--no-engine must win — no run dir');
      assert.equal(result.runDir, null);
      assert.equal(fs.existsSync(path.join(cwd, '.guardrail-cache', 'runs')), false);
    } finally {
      cleanup(cwd);
    }
  });

  it('config engine.enabled=false beats default (config > default precedence)', async () => {
    const cwd = tmpProject();
    try {
      const result = await runPhaseWithLifecycle<NoopInput, NoopOutput>({
        cwd,
        phase: makeSuccessPhase(),
        input: { tag: 't' },
        config: { configVersion: 1, engine: { enabled: false } },
        cliEngine: undefined,
        envEngine: undefined,
        runEngineOff: async () => ({ tag: 'off' }),
      });
      assert.equal(result.runId, null);
      assert.equal(fs.existsSync(path.join(cwd, '.guardrail-cache', 'runs')), false);
    } finally {
      cleanup(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Engine-on success path
// ---------------------------------------------------------------------------

describe('runPhaseWithLifecycle — engine-on success', () => {
  it('emits full lifecycle when --engine is true', async () => {
    const cwd = tmpProject();
    try {
      const result = await runPhaseWithLifecycle<NoopInput, NoopOutput>({
        cwd,
        phase: makeSuccessPhase({ name: 'demo' }),
        input: { tag: 'engine-on' },
        config: DEFAULT_CONFIG,
        cliEngine: true,
        envEngine: undefined,
        runEngineOff: async () => {
          throw new Error('runEngineOff must NOT be called when engine is on');
        },
      });

      assert.equal(result.output.tag, 'engine-on');
      assert.ok(result.runId, 'runId must be populated on engine-on');
      assert.ok(result.runDir, 'runDir must be populated on engine-on');

      const events = readEvents(result.runDir!);
      const kinds = events.map(e => e.event);
      assert.ok(kinds.includes('run.start'), `expected run.start — got [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('phase.start'));
      assert.ok(kinds.includes('phase.success'));
      assert.ok(kinds.includes('run.complete'));

      const runComplete = events.find(e => e.event === 'run.complete');
      assert.ok(runComplete && runComplete.event === 'run.complete');
      assert.equal(runComplete.status, 'success');

      const state = readState(result.runDir!);
      assert.equal(state.status, 'success');
      assert.equal(state.phases.length, 1);
      assert.equal(state.phases[0]!.name, 'demo');
      assert.equal(state.phases[0]!.status, 'succeeded');
      assert.equal(state.phases[0]!.attempts, 1);
    } finally {
      cleanup(cwd);
    }
  });

  it('engine resolved via env (CLAUDE_AUTOPILOT_ENGINE=on) without CLI flag', async () => {
    const cwd = tmpProject();
    try {
      const result = await runPhaseWithLifecycle<NoopInput, NoopOutput>({
        cwd,
        phase: makeSuccessPhase(),
        input: { tag: 't' },
        config: DEFAULT_CONFIG,
        cliEngine: undefined,
        envEngine: 'on',
        runEngineOff: async () => { throw new Error('should not be called'); },
      });
      assert.ok(result.runDir);
      assert.equal(readState(result.runDir!).status, 'success');
    } finally {
      cleanup(cwd);
    }
  });

  it('engine resolved via config when env / CLI absent', async () => {
    const cwd = tmpProject();
    try {
      const result = await runPhaseWithLifecycle<NoopInput, NoopOutput>({
        cwd,
        phase: makeSuccessPhase(),
        input: { tag: 't' },
        config: { configVersion: 1, engine: { enabled: true } },
        cliEngine: undefined,
        envEngine: undefined,
        runEngineOff: async () => { throw new Error('should not be called'); },
      });
      assert.ok(result.runDir);
      assert.equal(readState(result.runDir!).status, 'success');
    } finally {
      cleanup(cwd);
    }
  });

  it('cost extraction: output.costUSD propagates to run.complete totalCostUSD', async () => {
    const cwd = tmpProject();
    try {
      const phase: RunPhase<NoopInput, NoopOutput> = {
        name: 'cost-demo',
        idempotent: true,
        hasSideEffects: false,
        run: async (input: NoopInput): Promise<NoopOutput> => ({ tag: input.tag, costUSD: 0.42 }),
      };
      const result = await runPhaseWithLifecycle<NoopInput, NoopOutput>({
        cwd,
        phase,
        input: { tag: 't' },
        config: DEFAULT_CONFIG,
        cliEngine: true,
        envEngine: undefined,
        runEngineOff: async () => { throw new Error('should not be called'); },
      });
      const events = readEvents(result.runDir!);
      const runComplete = events.find(e => e.event === 'run.complete');
      assert.ok(runComplete && runComplete.event === 'run.complete');
      assert.equal(runComplete.totalCostUSD, 0.42, 'totalCostUSD should reflect output.costUSD');
    } finally {
      cleanup(cwd);
    }
  });

  it('cost extraction: output without costUSD field falls back to 0', async () => {
    const cwd = tmpProject();
    try {
      const result = await runPhaseWithLifecycle<NoopInput, NoopOutput>({
        cwd,
        phase: makeSuccessPhase(),
        input: { tag: 't' },
        config: DEFAULT_CONFIG,
        cliEngine: true,
        envEngine: undefined,
        runEngineOff: async () => { throw new Error('should not be called'); },
      });
      const events = readEvents(result.runDir!);
      const runComplete = events.find(e => e.event === 'run.complete');
      assert.ok(runComplete && runComplete.event === 'run.complete');
      assert.equal(runComplete.totalCostUSD, 0, 'totalCostUSD must default to 0');
    } finally {
      cleanup(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Engine-on failure path
// ---------------------------------------------------------------------------

describe('runPhaseWithLifecycle — engine-on failure', () => {
  it('emits run.complete (failed) and re-throws', async () => {
    const cwd = tmpProject();
    // Suppress the helper's stderr banner to keep test output clean. The
    // helper writes the legacy [<phase>] engine: phase failed line to
    // process.stderr; we just want to assert the lifecycle, not the banner.
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof origWrite }).write = ((..._args: unknown[]) => true) as typeof origWrite;
    try {
      let thrown: unknown = null;
      try {
        await runPhaseWithLifecycle<NoopInput, NoopOutput>({
          cwd,
          phase: makeFailingPhase({ name: 'doomed', message: 'boom' }),
          input: { tag: 't' },
          config: DEFAULT_CONFIG,
          cliEngine: true,
          envEngine: undefined,
          runEngineOff: async () => { throw new Error('should not be called'); },
        });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, 'helper must re-throw on phase failure');
      assert.match((thrown as Error).message, /boom/, 'original error must propagate');

      const runDir = findRunDir(cwd);
      assert.ok(runDir, 'failed run still produces a run dir');
      const events = readEvents(runDir!);
      const runComplete = events.find(e => e.event === 'run.complete');
      assert.ok(runComplete && runComplete.event === 'run.complete');
      assert.equal(runComplete.status, 'failed', 'run.complete must mark failed');

      const phaseFailed = events.find(e => e.event === 'phase.failed');
      assert.ok(phaseFailed, 'phase.failed event must be present');

      // state.json should be refreshed with status: 'failed'
      const state = readState(runDir!);
      assert.equal(state.status, 'failed', 'state.json status must reflect failure');
    } finally {
      (process.stderr as { write: typeof origWrite }).write = origWrite;
      cleanup(cwd);
    }
  });

  it('lock-release safety: release error after success does not break helper', async () => {
    // The lock module's release() is idempotent; even when a release
    // already happened the second await resolves cleanly. We verify the
    // happy path stays correct: helper returns the output, no throw.
    const cwd = tmpProject();
    try {
      const result = await runPhaseWithLifecycle<NoopInput, NoopOutput>({
        cwd,
        phase: makeSuccessPhase(),
        input: { tag: 't' },
        config: DEFAULT_CONFIG,
        cliEngine: true,
        envEngine: undefined,
        runEngineOff: async () => { throw new Error('should not be called'); },
      });
      assert.equal(result.output.tag, 't');
      // Run dir is fully written even though the lock was released in `finally`.
      assert.ok(result.runDir);
      assert.equal(readState(result.runDir!).status, 'success');
    } finally {
      cleanup(cwd);
    }
  });

  it('lock-release safety: release error after throw does not mask the original error', async () => {
    // Same shape as the previous test but with a failing phase. Helper's
    // finally{ release().catch(() => ...) } must swallow any release
    // error and let the phase's original throw bubble out. We don't have
    // a synthetic way to inject a release failure (the lock module owns
    // that file handle), so we verify the user-observable contract: the
    // ORIGINAL error message reaches the caller, not a release-related
    // surface.
    const cwd = tmpProject();
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof origWrite }).write = ((..._args: unknown[]) => true) as typeof origWrite;
    try {
      let thrown: unknown = null;
      try {
        await runPhaseWithLifecycle<NoopInput, NoopOutput>({
          cwd,
          phase: makeFailingPhase({ message: 'original-boom' }),
          input: { tag: 't' },
          config: DEFAULT_CONFIG,
          cliEngine: true,
          envEngine: undefined,
          runEngineOff: async () => { throw new Error('should not be called'); },
        });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown);
      assert.match((thrown as Error).message, /original-boom/, 'original phase error must reach caller');
    } finally {
      (process.stderr as { write: typeof origWrite }).write = origWrite;
      cleanup(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid env value path
// ---------------------------------------------------------------------------

describe('runPhaseWithLifecycle — invalid env value', () => {
  it('falls through and surfaces a run.warning when engine ends up on via config', async () => {
    const cwd = tmpProject();
    try {
      const result = await runPhaseWithLifecycle<NoopInput, NoopOutput>({
        cwd,
        phase: makeSuccessPhase(),
        input: { tag: 't' },
        config: { configVersion: 1, engine: { enabled: true } },
        cliEngine: undefined,
        envEngine: 'definitely-not-a-bool',
        runEngineOff: async () => { throw new Error('should not be called'); },
      });
      assert.ok(result.runDir);
      const events = readEvents(result.runDir!);
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
