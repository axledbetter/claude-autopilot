import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPhase,
  type RunPhase,
} from '../../src/core/run-state/phase-runner.ts';
import { appendEvent, readEvents } from '../../src/core/run-state/events.ts';
import { makeWriterId } from '../../src/core/run-state/lock.ts';
import {
  readPhaseSnapshot,
} from '../../src/core/run-state/snapshot.ts';
import { GuardrailError } from '../../src/core/errors.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-phase-runner-'));
}

const writerId = makeWriterId();

/** Seed a runDir with a minimal `run.start` so phase-event seq starts at 2. */
function seedRun(runDir: string, phases: string[]): string {
  const runId = path.basename(runDir);
  appendEvent(
    runDir,
    { event: 'run.start', phases },
    { writerId, runId },
  );
  return runId;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runPhase — happy path', () => {
  it('emits phase.start → phase.success and writes a succeeded snapshot', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['plan']);
    const phase: RunPhase<{ x: number }, { y: number }> = {
      name: 'plan',
      idempotent: false,
      hasSideEffects: false,
      run: async (input) => ({ y: input.x * 2 }),
    };
    const out = await runPhase(phase, { x: 21 }, {
      runDir: dir, runId, writerId, phaseIdx: 0,
    });
    assert.deepEqual(out, { y: 42 });

    const { events } = readEvents(dir);
    const kinds = events.map(e => e.event);
    assert.deepEqual(kinds, ['run.start', 'phase.start', 'phase.success']);

    const snap = readPhaseSnapshot(dir, 'plan');
    assert.equal(snap?.status, 'succeeded');
    assert.equal(snap?.attempts, 1);
    assert.equal(snap?.idempotent, false);
    assert.equal(snap?.hasSideEffects, false);
    assert.ok(typeof snap?.durationMs === 'number');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records emitted costs and aggregates them on the snapshot', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['scan']);
    const phase: RunPhase<void, void> = {
      name: 'scan',
      idempotent: true,
      hasSideEffects: false,
      run: async (_input, ctx) => {
        ctx.emitCost({ provider: 'anthropic', inputTokens: 100, outputTokens: 50, costUSD: 0.07 });
        ctx.emitCost({ provider: 'anthropic', inputTokens: 200, outputTokens: 80, costUSD: 0.13 });
      },
    };
    await runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 });
    const { events } = readEvents(dir);
    const costEvents = events.filter(e => e.event === 'phase.cost');
    assert.equal(costEvents.length, 2);
    // Monotonic seq across emits.
    assert.ok((costEvents[1] as { seq: number }).seq > (costEvents[0] as { seq: number }).seq);

    const snap = readPhaseSnapshot(dir, 'scan');
    // Floating-point sum — allow tiny epsilon.
    assert.ok(Math.abs((snap?.costUSD ?? 0) - 0.20) < 1e-9, `expected ~0.20 got ${snap?.costUSD}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records emitted externalRefs on the snapshot with observedAt stamped', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['pr']);
    const phase: RunPhase<void, void> = {
      name: 'pr',
      idempotent: false,
      hasSideEffects: true,
      run: async (_input, ctx) => {
        ctx.emitExternalRef({
          kind: 'github-pr',
          id: '123',
          provider: 'github',
          url: 'https://github.com/example/repo/pull/123',
        });
      },
    };
    await runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 });
    const snap = readPhaseSnapshot(dir, 'pr');
    assert.equal(snap?.externalRefs.length, 1);
    assert.equal(snap?.externalRefs[0]?.kind, 'github-pr');
    assert.equal(snap?.externalRefs[0]?.id, '123');
    assert.ok(snap?.externalRefs[0]?.observedAt, 'observedAt must be stamped');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Throw path
// ---------------------------------------------------------------------------

describe('runPhase — throw path', () => {
  it('emits phase.failed, writes failed snapshot, and rethrows', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['validate']);
    const phase: RunPhase<void, void> = {
      name: 'validate',
      idempotent: true,
      hasSideEffects: false,
      run: async () => {
        throw new Error('tsc found 5 new errors');
      },
    };
    await assert.rejects(
      runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 }),
      (err: unknown) => err instanceof Error && /tsc found 5 new errors/.test(err.message),
    );
    const { events } = readEvents(dir);
    const failed = events.find(e => e.event === 'phase.failed');
    assert.ok(failed, 'phase.failed event missing');
    assert.equal((failed as { error: string }).error, 'tsc found 5 new errors');

    const snap = readPhaseSnapshot(dir, 'validate');
    assert.equal(snap?.status, 'failed');
    assert.equal(snap?.lastError, 'tsc found 5 new errors');
    assert.equal(snap?.attempts, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves GuardrailError code on phase.failed', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['migrate']);
    const phase: RunPhase<void, void> = {
      name: 'migrate',
      idempotent: false,
      hasSideEffects: true,
      run: async () => {
        throw new GuardrailError('bad config', { code: 'invalid_config', provider: 'test' });
      },
    };
    await assert.rejects(
      runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 }),
      (err: unknown) => err instanceof GuardrailError && err.code === 'invalid_config',
    );
    const { events } = readEvents(dir);
    const failed = events.find(e => e.event === 'phase.failed') as
      | { errorCode?: string }
      | undefined;
    assert.equal(failed?.errorCode, 'invalid_config');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('captures costs emitted before the throw on the failed snapshot', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['plan']);
    const phase: RunPhase<void, void> = {
      name: 'plan',
      idempotent: true,
      hasSideEffects: false,
      run: async (_in, ctx) => {
        ctx.emitCost({ provider: 'openai', inputTokens: 1, outputTokens: 1, costUSD: 0.05 });
        throw new Error('boom');
      },
    };
    await assert.rejects(runPhase(phase, undefined, {
      runDir: dir, runId, writerId, phaseIdx: 0,
    }));
    const snap = readPhaseSnapshot(dir, 'plan');
    assert.equal(snap?.status, 'failed');
    assert.ok(Math.abs((snap?.costUSD ?? 0) - 0.05) < 1e-9);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Idempotency / side-effects gating
// ---------------------------------------------------------------------------

describe('runPhase — idempotency / side-effects gating', () => {
  it('idempotent + prior success → short-circuits with run.warning, never re-runs', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['validate']);
    let runCount = 0;
    const phase: RunPhase<void, void> = {
      name: 'validate',
      idempotent: true,
      hasSideEffects: false,
      run: async () => {
        runCount += 1;
      },
    };
    // First attempt — succeeds.
    await runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 });
    assert.equal(runCount, 1);

    // Second attempt — runner should refuse to re-run; throws so the caller
    // knows to consult the prior snapshot / onResume hook.
    await assert.rejects(
      runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 }),
      (err: unknown) => err instanceof GuardrailError && err.code === 'superseded',
    );
    assert.equal(runCount, 1, 'phase.run must not have been called again');

    const { events } = readEvents(dir);
    const warns = events.filter(
      e => e.event === 'run.warning'
        && (e as { details?: { reason?: string } }).details?.reason === 'idempotent-replay',
    );
    assert.equal(warns.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('side-effecting + prior success + no forceReplay → emits phase.needs-human and throws', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['pr']);
    const phase: RunPhase<void, { prNumber: number }> = {
      name: 'pr',
      idempotent: false,
      hasSideEffects: true,
      run: async (_in, ctx) => {
        ctx.emitExternalRef({ kind: 'github-pr', id: '99', provider: 'github' });
        return { prNumber: 99 };
      },
    };
    await runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 });

    await assert.rejects(
      runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 }),
      (err: unknown) =>
        err instanceof GuardrailError
        && err.code === 'superseded'
        && /side-effecting-replay-needs-human/.test(JSON.stringify(err.details)),
    );
    const { events } = readEvents(dir);
    const nh = events.find(e => e.event === 'phase.needs-human');
    assert.ok(nh, 'phase.needs-human event must be emitted');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('side-effecting + prior success + forceReplay=true → re-runs and notes override', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['deploy']);
    let runCount = 0;
    const phase: RunPhase<void, void> = {
      name: 'deploy',
      idempotent: false,
      hasSideEffects: true,
      run: async () => {
        runCount += 1;
      },
    };
    await runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 });
    await runPhase(phase, undefined, {
      runDir: dir, runId, writerId, phaseIdx: 0, forceReplay: true,
    });
    assert.equal(runCount, 2);

    const { events } = readEvents(dir);
    const overrides = events.filter(
      e => e.event === 'run.warning'
        && (e as { details?: { reason?: string } }).details?.reason === 'force-replay',
    );
    assert.equal(overrides.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Sub-phases
// ---------------------------------------------------------------------------

describe('runPhase — sub-phases', () => {
  it('records nested phase.start / phase.success with synthetic child phaseIdx', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['council']);

    const child: RunPhase<{ q: string }, { a: string }> = {
      name: 'consult',
      idempotent: true,
      hasSideEffects: false,
      run: async (input) => ({ a: `re: ${input.q}` }),
    };
    const parent: RunPhase<void, void> = {
      name: 'council',
      idempotent: false,
      hasSideEffects: false,
      run: async (_in, ctx) => {
        assert.ok(ctx.subPhase, 'subPhase factory missing');
        const r1 = await ctx.subPhase!(child, { q: 'one' });
        const r2 = await ctx.subPhase!(child, { q: 'two' });
        assert.equal(r1.a, 're: one');
        assert.equal(r2.a, 're: two');
      },
    };
    await runPhase(parent, undefined, { runDir: dir, runId, writerId, phaseIdx: 1 });

    const { events } = readEvents(dir);
    const startsByIdx = events
      .filter(e => e.event === 'phase.start')
      .map(e => (e as { phaseIdx: number; phase: string }));
    // One parent (idx=1) + two children (idx=(1+1)*1000+1=2001 and 2002).
    const idxs = startsByIdx.map(e => e.phaseIdx).sort((a, b) => a - b);
    assert.deepEqual(idxs, [1, 2001, 2002]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sub-phase indices do not collide with top-level indices when parent=0 (Bugbot HIGH, PR #87)', async () => {
    // Regression: prior encoding `parentPhaseIdx * 1000 + childOrdinal`
    // collapsed to 1, 2, 3… for parent=0, directly colliding with the
    // top-level phases at those exact indices. Since createRun uses
    // 0-based indexing, the FIRST top-level phase always triggered this.
    // Fix: `(parentPhaseIdx + 1) * 1000 + childOrdinal`. Children of
    // parent=0 are now 1001, 1002, 1003 — non-colliding.
    const dir = tmp();
    const runId = path.basename(dir);
    fs.mkdirSync(dir, { recursive: true });
    appendEvent(dir, { event: 'run.start', phases: ['parent', 'sibling'] }, { runId, writerId });

    const child: RunPhase<void, void> = {
      name: 'child', idempotent: true, hasSideEffects: false,
      run: async () => {},
    };
    const parent: RunPhase<void, void> = {
      name: 'parent', idempotent: false, hasSideEffects: false,
      run: async (_i, ctx) => {
        await ctx.subPhase!(child, undefined);
        await ctx.subPhase!(child, undefined);
      },
    };
    // Parent at idx=0 — the case that used to collide.
    await runPhase(parent, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 });

    const { events } = readEvents(dir);
    const startIdxs = events
      .filter(e => e.event === 'phase.start')
      .map(e => (e as { phaseIdx: number }).phaseIdx)
      .sort((a, b) => a - b);
    // Expect 0 (parent), 1001, 1002 (children) — NEVER 1 or 2 which would
    // collide with regular top-level phases at those indices.
    assert.deepEqual(startIdxs, [0, 1001, 1002]);
    assert.equal(startIdxs.includes(1), false, 'child index 1 would collide with top-level phase 1');
    assert.equal(startIdxs.includes(2), false, 'child index 2 would collide with top-level phase 2');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
