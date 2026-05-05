import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runPhase,
  type RunPhase,
} from '../../src/core/run-state/phase-runner.ts';
import type { BudgetCheck } from '../../src/core/run-state/budget.ts';
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
    // Phase 6 — short-circuit reason renamed from idempotent-replay to
    // skip-already-applied (the canonical decision verb from decideReplay).
    const warns = events.filter(
      e => e.event === 'run.warning'
        && (e as { details?: { reason?: string } }).details?.reason === 'skip-already-applied',
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
    // Phase 6 — force-replay now emits a dedicated replay.override event
    // instead of a generic run.warning. Spec: "a `--force-replay` override
    // writes an explicit `replay.override` event with user-supplied reason."
    const overrides = events.filter(e => e.event === 'replay.override');
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

// ---------------------------------------------------------------------------
// Phase 4 — budget enforcement
// ---------------------------------------------------------------------------

describe('runPhase — budget enforcement (Phase 4)', () => {
  it('back-compat: no budget config → no budget.check event, no rejection', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['plan']);
    const phase: RunPhase<void, void> = {
      name: 'plan', idempotent: false, hasSideEffects: false,
      run: async () => {},
    };
    await runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 });
    const { events } = readEvents(dir);
    const budgetEvents = events.filter(e => e.event === 'budget.check');
    assert.equal(budgetEvents.length, 0, 'no budget config means no budget.check event');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('proceed decision: emits budget.check then proceeds normally', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['plan']);
    const phase: RunPhase<void, void> = {
      name: 'plan', idempotent: false, hasSideEffects: false,
      estimateCost: () => ({ lowUSD: 0.5, highUSD: 1 }),
      run: async () => {},
    };
    await runPhase(phase, undefined, {
      runDir: dir, runId, writerId, phaseIdx: 0,
      budget: { perRunUSD: 25 },
    });
    const { events } = readEvents(dir);
    const kinds = events.map(e => e.event);
    // budget.check MUST come before phase.start.
    const idxBudget = kinds.indexOf('budget.check');
    const idxStart = kinds.indexOf('phase.start');
    assert.ok(idxBudget >= 0 && idxStart >= 0);
    assert.ok(idxBudget < idxStart, 'budget.check must precede phase.start');
    const budgetEv = events[idxBudget] as {
      decision: string; estimatedHigh: number | null; reserveApplied: number;
    };
    assert.equal(budgetEv.decision, 'proceed');
    assert.equal(budgetEv.estimatedHigh, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hard-fail decision (CI mode): throws budget_exceeded, no phase.start emitted', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['big']);
    let executed = false;
    const phase: RunPhase<void, void> = {
      name: 'big', idempotent: false, hasSideEffects: false,
      run: async () => { executed = true; },
    };
    await assert.rejects(
      runPhase(phase, undefined, {
        runDir: dir, runId, writerId, phaseIdx: 0,
        budget: { perRunUSD: 1 }, // floor of $5 alone exceeds cap
        nonInteractive: true,
      }),
      (err: unknown) => err instanceof GuardrailError && err.code === 'budget_exceeded',
    );
    assert.equal(executed, false, 'phase.run must NOT execute on hard-fail');

    const { events } = readEvents(dir);
    const kinds = events.map(e => e.event);
    assert.ok(kinds.includes('budget.check'), 'budget.check must be emitted');
    assert.equal(kinds.includes('phase.start'), false, 'phase.start must NOT be emitted');
    assert.equal(kinds.includes('phase.failed'), false, 'phase.failed must NOT be emitted (phase never started)');

    const snap = readPhaseSnapshot(dir, 'big');
    assert.equal(snap, null, 'no phase snapshot when budget rejects pre-start');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('budget.check payload carries the full BudgetCheck shape', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['validate']);
    const phase: RunPhase<void, void> = {
      name: 'validate', idempotent: true, hasSideEffects: false,
      estimateCost: () => ({ lowUSD: 0.1, highUSD: 0.5 }),
      run: async () => {},
    };
    await runPhase(phase, undefined, {
      runDir: dir, runId, writerId, phaseIdx: 0,
      budget: { perRunUSD: 25, conservativePhaseReserveUSD: 1 },
    });
    const { events } = readEvents(dir);
    const ev = events.find(e => e.event === 'budget.check') as unknown as Record<string, unknown>;
    assert.ok(ev);
    assert.equal(ev.event, 'budget.check');
    assert.equal(ev.phase, 'validate');
    assert.equal(ev.phaseIdx, 0);
    assert.equal(ev.decision, 'proceed');
    assert.equal(ev.estimatedHigh, 0.5);
    assert.equal(ev.actualSoFar, 0);
    assert.equal(ev.reserveApplied, 1); // max(0.5, 1) = 1
    assert.equal(typeof ev.capRemaining, 'number');
    assert.equal(typeof ev.reason, 'string');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('actualSoFar aggregates phase.cost across the WHOLE run, not just this phase', async () => {
    // Seed the log with prior cost events from earlier phases so the
    // current phase's preflight sees them.
    const dir = tmp();
    const runId = seedRun(dir, ['phaseA', 'phaseB']);
    appendEvent(dir, {
      event: 'phase.cost', phase: 'phaseA', phaseIdx: 0,
      provider: 'openai', inputTokens: 1000, outputTokens: 500, costUSD: 4,
    }, { writerId, runId });
    appendEvent(dir, {
      event: 'phase.cost', phase: 'phaseA', phaseIdx: 0,
      provider: 'openai', inputTokens: 200, outputTokens: 100, costUSD: 2,
    }, { writerId, runId });

    const phase: RunPhase<void, void> = {
      name: 'phaseB', idempotent: false, hasSideEffects: false,
      estimateCost: () => ({ lowUSD: 0.5, highUSD: 1 }),
      run: async () => {},
    };
    // perRunUSD = 10, actualSoFar = 6, reserveApplied = max(1, 5) = 5
    // → 6 + 5 = 11 > 10 → hard-fail.
    await assert.rejects(
      runPhase(phase, undefined, {
        runDir: dir, runId, writerId, phaseIdx: 1,
        budget: { perRunUSD: 10 },
        nonInteractive: true,
      }),
      (err: unknown) => err instanceof GuardrailError && err.code === 'budget_exceeded',
    );
    const { events } = readEvents(dir);
    const ev = events.find(e => e.event === 'budget.check') as { actualSoFar: number };
    assert.equal(ev.actualSoFar, 6, 'actualSoFar must sum prior-phase costs');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pause decision (interactive): confirmBudgetPause returning true → proceeds', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['p']);
    let executed = false;
    let prompted: BudgetCheck | null = null;
    const phase: RunPhase<void, void> = {
      name: 'p', idempotent: false, hasSideEffects: false,
      run: async () => { executed = true; },
    };
    await runPhase(phase, undefined, {
      runDir: dir, runId, writerId, phaseIdx: 0,
      budget: { perRunUSD: 1 }, // floor of $5 alone exceeds cap → pause in interactive mode
      nonInteractive: false,
      confirmBudgetPause: async (check) => { prompted = check; return true; },
    });
    assert.equal(executed, true, 'phase.run must execute on user confirm');
    assert.ok(prompted, 'confirmBudgetPause must be called');
    assert.equal((prompted as BudgetCheck).decision, 'pause');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pause decision (interactive): confirmBudgetPause returning false → throws budget_exceeded', async () => {
    const dir = tmp();
    const runId = seedRun(dir, ['p']);
    let executed = false;
    const phase: RunPhase<void, void> = {
      name: 'p', idempotent: false, hasSideEffects: false,
      run: async () => { executed = true; },
    };
    await assert.rejects(
      runPhase(phase, undefined, {
        runDir: dir, runId, writerId, phaseIdx: 0,
        budget: { perRunUSD: 1 },
        nonInteractive: false,
        confirmBudgetPause: async () => false,
      }),
      (err: unknown) =>
        err instanceof GuardrailError
        && err.code === 'budget_exceeded'
        && (err.details as { userDenied?: boolean }).userDenied === true,
    );
    assert.equal(executed, false, 'phase.run must NOT execute on user deny');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('idempotent short-circuit takes precedence over budget check (no budget.check emitted)', async () => {
    // If a phase already succeeded and is idempotent, the runner short-
    // circuits BEFORE the budget preflight. This is the right ordering:
    // a no-op replay shouldn't burn budget headroom or trigger spurious
    // budget.check events.
    const dir = tmp();
    const runId = seedRun(dir, ['validate']);
    const phase: RunPhase<void, void> = {
      name: 'validate', idempotent: true, hasSideEffects: false,
      run: async () => {},
    };
    // First run — no budget config, succeeds normally.
    await runPhase(phase, undefined, { runDir: dir, runId, writerId, phaseIdx: 0 });

    // Second run — with a budget config that WOULD reject. Idempotent
    // short-circuit must fire first (throwing 'superseded'), so no
    // budget.check event is emitted.
    await assert.rejects(
      runPhase(phase, undefined, {
        runDir: dir, runId, writerId, phaseIdx: 0,
        budget: { perRunUSD: 0.01 },
        nonInteractive: true,
      }),
      (err: unknown) => err instanceof GuardrailError && err.code === 'superseded',
    );

    const { events } = readEvents(dir);
    const budgetChecks = events.filter(e => e.event === 'budget.check');
    assert.equal(budgetChecks.length, 0, 'idempotent short-circuit must skip budget preflight');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('phase without estimateCost: Layer 2 floor still enforces (Codex CRITICAL #3)', async () => {
    // The whole point of Layer 2 — even a phase that doesn't declare
    // estimateCost gets gated by the conservative floor. Otherwise a phase
    // can silently bypass budget enforcement by simply omitting the field.
    const dir = tmp();
    const runId = seedRun(dir, ['unknown']);
    const phase: RunPhase<void, void> = {
      name: 'unknown', idempotent: false, hasSideEffects: false,
      // no estimateCost
      run: async () => {},
    };
    await assert.rejects(
      runPhase(phase, undefined, {
        runDir: dir, runId, writerId, phaseIdx: 0,
        budget: { perRunUSD: 3 }, // 0 + 5 floor = 5 > 3 → hard-fail
        nonInteractive: true,
      }),
      (err: unknown) => err instanceof GuardrailError && err.code === 'budget_exceeded',
    );
    const { events } = readEvents(dir);
    const ev = events.find(e => e.event === 'budget.check') as {
      estimatedHigh: number | null; reserveApplied: number; decision: string;
    };
    assert.equal(ev.estimatedHigh, null);
    assert.equal(ev.reserveApplied, 5);
    assert.equal(ev.decision, 'hard-fail');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
