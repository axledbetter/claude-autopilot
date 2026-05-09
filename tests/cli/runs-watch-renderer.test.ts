// tests/cli/runs-watch-renderer.test.ts
//
// v6.1 — pure-renderer unit tests. The renderer is referentially transparent
// so every case is a string-equality / regex assertion. Tests run instantly.
//
// Coverage targets every event-line variant + the budget bar's three color
// thresholds + the header + the final-summary block + ANSI on/off symmetry.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  colorize,
  fmtUSD,
  renderBudgetBar,
  renderEventLine,
  renderFinalSummary,
  renderHeader,
  stripAnsi,
} from '../../src/cli/runs-watch-renderer.ts';
import { RUN_STATE_SCHEMA_VERSION, type RunEvent, type RunState } from '../../src/core/run-state/types.ts';
import type { BudgetConfig } from '../../src/core/run-state/budget.ts';

// ----------------------------------------------------------------------------
// Tiny fixture builders.
// ----------------------------------------------------------------------------

function mkBaseEvent(seq: number): { schema_version: typeof RUN_STATE_SCHEMA_VERSION; ts: string; runId: string; seq: number; writerId: { pid: 0; hostHash: '' } } {
  return {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    ts: '2026-05-04T12:00:42.123Z',
    runId: '01HZK7P3D8Q9V00000000000AB',
    seq,
    writerId: { pid: 0, hostHash: '' },
  };
}

function mkState(overrides: Partial<RunState> = {}): RunState {
  return {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    runId: '01HZK7P3D8Q9V00000000000AB',
    startedAt: '2026-05-04T12:00:00.000Z',
    status: 'running',
    phases: [
      { schema_version: RUN_STATE_SCHEMA_VERSION, name: 'spec', index: 0, status: 'succeeded', idempotent: false, hasSideEffects: false, costUSD: 0.5, attempts: 1, artifacts: [], externalRefs: [] },
      { schema_version: RUN_STATE_SCHEMA_VERSION, name: 'plan', index: 1, status: 'running', idempotent: false, hasSideEffects: false, costUSD: 0, attempts: 1, artifacts: [], externalRefs: [] },
      { schema_version: RUN_STATE_SCHEMA_VERSION, name: 'pr', index: 2, status: 'pending', idempotent: false, hasSideEffects: true, costUSD: 0, attempts: 0, artifacts: [], externalRefs: [] },
    ],
    currentPhaseIdx: 1,
    totalCostUSD: 0.5,
    lastEventSeq: 5,
    writerId: { pid: 0, hostHash: '' },
    cwd: '/tmp/test',
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// Money / ANSI helpers
// ----------------------------------------------------------------------------

describe('fmtUSD', () => {
  it('formats positive values with two decimals', () => {
    assert.equal(fmtUSD(0), '$0.00');
    assert.equal(fmtUSD(1.5), '$1.50');
    assert.equal(fmtUSD(123.456), '$123.46');
  });
  it('formats negatives with leading -$', () => {
    assert.equal(fmtUSD(-0.42), '-$0.42');
    assert.equal(fmtUSD(-1000), '-$1000.00');
  });
});

describe('colorize / stripAnsi', () => {
  it('returns plain text when ansi=false', () => {
    assert.equal(colorize('hello', 'red', false), 'hello');
  });
  it('wraps in escape codes when ansi=true', () => {
    const got = colorize('hello', 'red', true);
    assert.notEqual(got, 'hello');
    assert.equal(stripAnsi(got), 'hello');
  });
  it('stripAnsi is idempotent on plain text', () => {
    assert.equal(stripAnsi('plain'), 'plain');
  });
});

// ----------------------------------------------------------------------------
// Budget bar — three color thresholds + the no-cap fallback.
// ----------------------------------------------------------------------------

describe('renderBudgetBar', () => {
  const budget: BudgetConfig = { perRunUSD: 25 };

  it('shows running total only when budget is null', () => {
    const out = renderBudgetBar(4.20, null, { ansi: false });
    assert.match(out, /\$4\.20/);
    assert.match(out, /no cap/);
  });

  it('green at <50%', () => {
    const out = renderBudgetBar(5, budget, { ansi: true });
    assert.match(out, /\$5\.00 \/ \$25\.00 \(20%\)/);
    // Green code 32 must appear; red 31 / yellow 33 must not.
    assert.match(out, /\x1b\[32m/);
    assert.doesNotMatch(out, /\x1b\[33m/);
    assert.doesNotMatch(out, /\x1b\[31m/);
  });

  it('yellow at 50-90%', () => {
    const out = renderBudgetBar(15, budget, { ansi: true });
    assert.match(out, /\(60%\)/);
    assert.match(out, /\x1b\[33m/);
    assert.doesNotMatch(out, /\x1b\[31m/);
  });

  it('red at >90%', () => {
    const out = renderBudgetBar(24, budget, { ansi: true });
    assert.match(out, /\(96%\)/);
    assert.match(out, /\x1b\[31m/);
    assert.doesNotMatch(out, /\x1b\[33m/);
  });

  it('clamps absurd over-budget percentages', () => {
    const out = renderBudgetBar(2500, budget, { ansi: false });
    // 10000% would blow the column; we clamp at 999%.
    assert.match(out, /\(999%\)/);
  });

  it('handles perRunUSD=0 without divide-by-zero', () => {
    const zero: BudgetConfig = { perRunUSD: 0 };
    const out = renderBudgetBar(0, zero, { ansi: false });
    assert.match(out, /\(0%\)/);
  });
});

// ----------------------------------------------------------------------------
// Header.
// ----------------------------------------------------------------------------

describe('renderHeader', () => {
  it('renders run id + phases + budget when budget present', () => {
    const state = mkState();
    const lines = renderHeader(state, { perRunUSD: 25 }, { ansi: false });
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /run 01HZK7P3D8Q9V00000000000AB/);
    assert.match(lines[1]!, /spec.*plan.*pr/);
    assert.match(lines[2]!, /\$0\.50 \/ \$25\.00/);
  });

  it('omits the phase line when there are no phases', () => {
    const state = mkState({ phases: [] });
    const lines = renderHeader(state, null, { ansi: false });
    // header + budget only
    assert.equal(lines.length, 2);
  });

  it('uses ▶ in TTY and * in plain mode', () => {
    const state = mkState();
    const ttyLines = renderHeader(state, null, { ansi: true });
    const plainLines = renderHeader(state, null, { ansi: false });
    assert.match(ttyLines[0]!, /▶/);
    assert.match(plainLines[0]!, /^\*/);
  });
});

// ----------------------------------------------------------------------------
// Per-event lines.
// ----------------------------------------------------------------------------

describe('renderEventLine', () => {
  const opts = { ansi: false };

  it('run.start lists phases', () => {
    const ev: RunEvent = {
      ...mkBaseEvent(1),
      event: 'run.start',
      phases: ['spec', 'plan', 'implement'],
    };
    const out = renderEventLine(ev, 0, opts);
    assert.match(out, /\[12:00:42\]/);
    assert.match(out, /run\.start/);
    assert.match(out, /\[spec, plan, implement\]/);
  });

  it('phase.start labels the phase', () => {
    const ev: RunEvent = {
      ...mkBaseEvent(2),
      event: 'phase.start', phase: 'spec', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    };
    const out = renderEventLine(ev, 0, opts);
    assert.match(out, /phase\.start/);
    assert.match(out, /spec/);
    assert.doesNotMatch(out, /attempt/);
  });

  it('phase.start surfaces attempt number when retrying', () => {
    const ev: RunEvent = {
      ...mkBaseEvent(2),
      event: 'phase.start', phase: 'spec', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 3,
    };
    const out = renderEventLine(ev, 0, opts);
    assert.match(out, /\(attempt 3\)/);
  });

  it('phase.cost shows delta + tokens + running total', () => {
    const ev: RunEvent = {
      ...mkBaseEvent(3),
      event: 'phase.cost', phase: 'spec', phaseIdx: 0,
      provider: 'anthropic', inputTokens: 1234, outputTokens: 5678, costUSD: 0.07,
    };
    const out = renderEventLine(ev, 0.07, opts);
    assert.match(out, /\+\$0\.07/);
    assert.match(out, /in: 1\.2k/);
    assert.match(out, /out: 5\.7k/);
    assert.match(out, /total: \$0\.07/);
  });

  it('phase.cost uses M suffix for large token counts', () => {
    const ev: RunEvent = {
      ...mkBaseEvent(3),
      event: 'phase.cost', phase: 'implement', phaseIdx: 1,
      provider: 'anthropic', inputTokens: 1_500_000, outputTokens: 250, costUSD: 5.0,
    };
    const out = renderEventLine(ev, 5.0, opts);
    assert.match(out, /1\.5M/);
  });

  it('phase.success shows duration + check glyph', () => {
    const ev: RunEvent = {
      ...mkBaseEvent(4),
      event: 'phase.success', phase: 'spec', phaseIdx: 0,
      durationMs: 44231, artifacts: [],
    };
    const ttyOut = renderEventLine(ev, 0, { ansi: true });
    const plainOut = renderEventLine(ev, 0, { ansi: false });
    assert.match(stripAnsi(ttyOut), /✓/);
    assert.match(plainOut, /OK/);
    assert.match(plainOut, /44\.2s/);
  });

  it('phase.failed truncates long error messages', () => {
    const longErr = 'x'.repeat(120);
    const ev: RunEvent = {
      ...mkBaseEvent(5),
      event: 'phase.failed', phase: 'pr', phaseIdx: 2,
      durationMs: 1500, error: longErr,
    };
    const out = renderEventLine(ev, 0, opts);
    assert.match(out, /phase\.failed/);
    assert.match(out, /\.\.\./);
    // Stripped error body (77 chars) + 3 dots = 80 chars
    assert.ok(out.includes('x'.repeat(77) + '...'));
  });

  it('phase.externalRef shows kind#id with arrow glyph', () => {
    const ev: RunEvent = {
      ...mkBaseEvent(6),
      event: 'phase.externalRef', phase: 'pr', phaseIdx: 2,
      ref: { kind: 'github-pr', id: '123', observedAt: '2026-05-04T12:00:00Z' },
    };
    const ttyOut = renderEventLine(ev, 0, { ansi: true });
    const plainOut = renderEventLine(ev, 0, { ansi: false });
    assert.match(stripAnsi(ttyOut), /→ github-pr#123/);
    assert.match(plainOut, /-> github-pr#123/);
  });

  it('budget.check colors decision: dim/yellow/red', () => {
    const base = {
      ...mkBaseEvent(7),
      event: 'budget.check' as const, phase: 'plan', phaseIdx: 1,
      estimatedHigh: 1.5, actualSoFar: 3.2, reserveApplied: 5,
      capRemaining: 18.3, reason: 'layer2-mandatory-pass',
    };
    const proceed: RunEvent = { ...base, decision: 'proceed' };
    const pause: RunEvent = { ...base, decision: 'pause' };
    const hardFail: RunEvent = { ...base, decision: 'hard-fail' };
    assert.match(renderEventLine(proceed, 3.2, { ansi: true }), /\x1b\[2m/);   // dim
    assert.match(renderEventLine(pause, 3.2, { ansi: true }), /\x1b\[33m/);    // yellow
    assert.match(renderEventLine(hardFail, 3.2, { ansi: true }), /\x1b\[31m/); // red
  });

  it('run.complete uses bold-green for success', () => {
    const ev: RunEvent = {
      ...mkBaseEvent(8),
      event: 'run.complete', status: 'success',
      totalCostUSD: 4.20, durationMs: 512_000,
    };
    const out = renderEventLine(ev, 4.20, { ansi: true });
    // Bold + green = \x1b[1m\x1b[32m
    assert.match(out, /\x1b\[1m\x1b\[32m/);
    assert.match(stripAnsi(out), /status=success/);
    assert.match(stripAnsi(out), /\$4\.20/);
    assert.match(stripAnsi(out), /8m32s/);
  });

  it('run.complete uses bold-red for failed', () => {
    const ev: RunEvent = {
      ...mkBaseEvent(8),
      event: 'run.complete', status: 'failed',
      totalCostUSD: 12.0, durationMs: 1000,
    };
    const out = renderEventLine(ev, 12.0, { ansi: true });
    assert.match(out, /\x1b\[1m\x1b\[31m/);
  });

  it('falls back to verb-only line for opaque events', () => {
    const ev: RunEvent = {
      ...mkBaseEvent(9),
      event: 'index.rebuilt', cause: 'corrupt',
    };
    const out = renderEventLine(ev, 0, opts);
    assert.match(out, /index\.rebuilt/);
    assert.match(out, /corrupt/);
  });
});

// ----------------------------------------------------------------------------
// Final summary.
// ----------------------------------------------------------------------------

describe('renderFinalSummary', () => {
  it('green for success', () => {
    const lines = renderFinalSummary(
      { runId: 'X', status: 'success', totalCostUSD: 4.20, durationMs: 60_000 },
      { ansi: true },
    );
    assert.equal(lines.length, 3);
    assert.match(lines[1]!, /\x1b\[1m\x1b\[32m/);
  });

  it('yellow bold for interrupted', () => {
    const lines = renderFinalSummary(
      { runId: 'X', status: 'interrupted', totalCostUSD: 1, durationMs: 5000 },
      { ansi: true },
    );
    assert.match(lines[1]!, /\x1b\[1m\x1b\[33m/);
  });

  it('plain mode strips colors', () => {
    const lines = renderFinalSummary(
      { runId: 'X', status: 'success', totalCostUSD: 1, durationMs: 5000 },
      { ansi: false },
    );
    assert.equal(stripAnsi(lines.join('\n')), lines.join('\n'));
  });
});
