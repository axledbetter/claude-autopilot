// tests/cli/runs-watch.test.ts
//
// v6.1 — verb-level tests for `runs watch <id>`. We exercise the handler
// directly (no subprocesses) using the `__test*` seams — the same pattern
// the engine-smoke tests use for the wrapped pipeline phases.
//
// 8 cases:
//   1. --no-follow snapshot (folds existing events, prints, exits)
//   2. --since <seq> replay
//   3. --json mode (NDJSON output, ANSI stripped, no header)
//   4. Run-not-found exits 2 with not_found
//   5. Live tail picks up appended events
//   6. Budget rendering when BudgetConfig is recorded in state.config
//   7. run.complete event triggers automatic exit
//   8. Invalid ULID rejected
//   + a couple of supporting cases on --since validation and ANSI behavior

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createRun } from '../../src/core/run-state/runs.ts';
import { appendEvent } from '../../src/core/run-state/events.ts';
import { ulid } from '../../src/core/run-state/ulid.ts';
import { runRunsWatch } from '../../src/cli/runs-watch.ts';

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-watch-'));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ----------------------------------------------------------------------------
// 1. --no-follow snapshot.
// ----------------------------------------------------------------------------

describe('runs watch --no-follow', () => {
  it('renders header + events + exits 0 for an active run', async () => {
    const cwd = tmpCwd();
    const run = await createRun({ cwd, phases: ['spec', 'plan'] });
    appendEvent(run.runDir, {
      event: 'phase.start', phase: 'spec', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    }, { writerId: run.lock.writerId, runId: run.runId });
    appendEvent(run.runDir, {
      event: 'phase.cost', phase: 'spec', phaseIdx: 0,
      provider: 'anthropic', inputTokens: 1000, outputTokens: 2000, costUSD: 0.05,
    }, { writerId: run.lock.writerId, runId: run.runId });
    await run.lock.release();

    const captured: string[] = [];
    const r = await runRunsWatch({
      runId: run.runId, cwd, noFollow: true,
      __testIsTTY: false,
      __testWriteStdout: s => captured.push(s),
    });
    assert.equal(r.exit, 0);
    const out = captured.join('');
    assert.match(out, new RegExp(run.runId));
    assert.match(out, /run\.start/);
    assert.match(out, /phase\.start/);
    assert.match(out, /phase\.cost/);
    assert.match(out, /\+\$0\.05/);
    cleanup(cwd);
  });

  it('renders final summary when the run has terminated', async () => {
    const cwd = tmpCwd();
    const run = await createRun({ cwd, phases: ['spec'] });
    appendEvent(run.runDir, {
      event: 'phase.start', phase: 'spec', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    }, { writerId: run.lock.writerId, runId: run.runId });
    appendEvent(run.runDir, {
      event: 'phase.success', phase: 'spec', phaseIdx: 0,
      durationMs: 1000, artifacts: [],
    }, { writerId: run.lock.writerId, runId: run.runId });
    appendEvent(run.runDir, {
      event: 'run.complete', status: 'success', totalCostUSD: 0, durationMs: 1500,
    }, { writerId: run.lock.writerId, runId: run.runId });
    await run.lock.release();

    // Mark state.json as success too (the appendEvent path doesn't update
    // state.json — that's the runner's job — so we patch it manually for
    // the test).
    const sp = path.join(run.runDir, 'state.json');
    const raw = JSON.parse(fs.readFileSync(sp, 'utf8'));
    raw.status = 'success';
    raw.endedAt = new Date().toISOString();
    fs.writeFileSync(sp, JSON.stringify(raw), 'utf8');

    const captured: string[] = [];
    const r = await runRunsWatch({
      runId: run.runId, cwd, noFollow: true,
      __testIsTTY: false,
      __testWriteStdout: s => captured.push(s),
    });
    assert.equal(r.exit, 0);
    const out = captured.join('');
    assert.match(out, /done/);
    assert.match(out, /status=success/);
    cleanup(cwd);
  });
});

// ----------------------------------------------------------------------------
// 2. --since <seq> replay.
// ----------------------------------------------------------------------------

describe('runs watch --since', () => {
  it('replay drops events with seq < since', async () => {
    const cwd = tmpCwd();
    const run = await createRun({ cwd, phases: ['spec'] });
    appendEvent(run.runDir, {
      event: 'phase.start', phase: 'spec', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    }, { writerId: run.lock.writerId, runId: run.runId });
    appendEvent(run.runDir, {
      event: 'phase.cost', phase: 'spec', phaseIdx: 0,
      provider: 'anthropic', inputTokens: 100, outputTokens: 200, costUSD: 0.01,
    }, { writerId: run.lock.writerId, runId: run.runId });
    await run.lock.release();

    const captured: string[] = [];
    const r = await runRunsWatch({
      runId: run.runId, cwd, noFollow: true, since: 3,
      __testIsTTY: false,
      __testWriteStdout: s => captured.push(s),
    });
    assert.equal(r.exit, 0);
    const out = captured.join('');
    // Header still printed (always).
    assert.match(out, /run /);
    // run.start (seq 1) and phase.start (seq 2) should be filtered out.
    assert.doesNotMatch(out, /run\.start/);
    assert.doesNotMatch(out, /phase\.start/);
    // phase.cost (seq 3) is the floor and should appear.
    assert.match(out, /phase\.cost/);
    cleanup(cwd);
  });

  it('rejects negative --since values', async () => {
    const cwd = tmpCwd();
    const run = await createRun({ cwd, phases: ['spec'] });
    await run.lock.release();
    const r = await runRunsWatch({
      runId: run.runId, cwd, noFollow: true, since: -5,
      __testIsTTY: false,
      __testWriteStdout: () => {},
    });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /invalid_config/);
    cleanup(cwd);
  });
});

// ----------------------------------------------------------------------------
// 3. --json mode emits raw NDJSON.
// ----------------------------------------------------------------------------

describe('runs watch --json', () => {
  it('emits one JSON event per line, ANSI stripped, no header', async () => {
    const cwd = tmpCwd();
    const run = await createRun({ cwd, phases: ['spec'] });
    appendEvent(run.runDir, {
      event: 'phase.start', phase: 'spec', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    }, { writerId: run.lock.writerId, runId: run.runId });
    await run.lock.release();

    const captured: string[] = [];
    const r = await runRunsWatch({
      runId: run.runId, cwd, noFollow: true, json: true,
      __testWriteStdout: s => captured.push(s),
    });
    assert.equal(r.exit, 0);
    const out = captured.join('');
    // No ANSI codes anywhere.
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(out, /\x1b\[/);
    // Each non-empty line parses as JSON with a known shape.
    const lines = out.split('\n').filter(l => l.length > 0);
    assert.ok(lines.length >= 2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(typeof parsed.event === 'string');
      assert.ok(typeof parsed.seq === 'number');
    }
    // No header line — JSON mode is byte-for-byte identical to events.ndjson.
    assert.doesNotMatch(out, /run [^"]/);  // no plain-text "run <id>" header
    cleanup(cwd);
  });
});

// ----------------------------------------------------------------------------
// 4. Run not found.
// ----------------------------------------------------------------------------

describe('runs watch error cases', () => {
  it('exits 2 not_found when the run dir is missing', async () => {
    const cwd = tmpCwd();
    const phantom = ulid();
    const r = await runRunsWatch({
      runId: phantom, cwd,
      __testIsTTY: false,
      __testWriteStdout: () => {},
    });
    assert.equal(r.exit, 2);
    assert.match(r.stderr.join('\n'), /not_found/);
    cleanup(cwd);
  });

  it('exits 1 invalid_config for non-ULID id', async () => {
    const cwd = tmpCwd();
    const r = await runRunsWatch({
      runId: 'not-a-ulid', cwd,
      __testIsTTY: false,
      __testWriteStdout: () => {},
    });
    assert.equal(r.exit, 1);
    assert.match(r.stderr.join('\n'), /invalid_config/);
    cleanup(cwd);
  });
});

// ----------------------------------------------------------------------------
// 5. Live tail.
// ----------------------------------------------------------------------------

describe('runs watch live tail', () => {
  it('picks up events appended after the watcher starts and exits on run.complete', async () => {
    const cwd = tmpCwd();
    const run = await createRun({ cwd, phases: ['spec'] });
    // Don't release the lock — we'll keep appending. (createRun returns the
    // lock so the writer can keep going.)
    const captured: string[] = [];
    const watchPromise = runRunsWatch({
      runId: run.runId, cwd,
      __testIsTTY: false,
      __testWriteStdout: s => captured.push(s),
      __testPollIntervalMs: 50, // tight poll for fast tests
    });

    // Give the watcher a beat to register fs.watchFile + drain initial.
    await new Promise(r => setTimeout(r, 100));

    // Append a sequence that simulates a phase running.
    appendEvent(run.runDir, {
      event: 'phase.start', phase: 'spec', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    }, { writerId: run.lock.writerId, runId: run.runId });
    await new Promise(r => setTimeout(r, 80));
    appendEvent(run.runDir, {
      event: 'phase.cost', phase: 'spec', phaseIdx: 0,
      provider: 'anthropic', inputTokens: 1000, outputTokens: 2000, costUSD: 0.10,
    }, { writerId: run.lock.writerId, runId: run.runId });
    await new Promise(r => setTimeout(r, 80));
    appendEvent(run.runDir, {
      event: 'phase.success', phase: 'spec', phaseIdx: 0,
      durationMs: 1500, artifacts: [],
    }, { writerId: run.lock.writerId, runId: run.runId });
    await new Promise(r => setTimeout(r, 80));
    appendEvent(run.runDir, {
      event: 'run.complete', status: 'success', totalCostUSD: 0.10, durationMs: 2000,
    }, { writerId: run.lock.writerId, runId: run.runId });

    const r = await watchPromise;
    await run.lock.release();

    assert.equal(r.exit, 0);
    const out = captured.join('');
    assert.match(out, /phase\.start/);
    assert.match(out, /phase\.cost/);
    assert.match(out, /\+\$0\.10/);
    assert.match(out, /phase\.success/);
    assert.match(out, /run\.complete/);
    cleanup(cwd);
  });
});

// ----------------------------------------------------------------------------
// 6. Budget rendering.
// ----------------------------------------------------------------------------

describe('runs watch budget rendering', () => {
  it('renders the budget bar when BudgetConfig is recorded in state.config', async () => {
    const cwd = tmpCwd();
    const run = await createRun({
      cwd, phases: ['spec'],
      config: { budget: { perRunUSD: 25 } },
    });
    await run.lock.release();
    const captured: string[] = [];
    const r = await runRunsWatch({
      runId: run.runId, cwd, noFollow: true,
      __testIsTTY: false,
      __testWriteStdout: s => captured.push(s),
    });
    assert.equal(r.exit, 0);
    const out = captured.join('');
    assert.match(out, /\$0\.00 \/ \$25\.00/);
    cleanup(cwd);
  });

  it('falls back to "no cap" when BudgetConfig is absent', async () => {
    const cwd = tmpCwd();
    const run = await createRun({ cwd, phases: ['spec'] });
    await run.lock.release();
    const captured: string[] = [];
    const r = await runRunsWatch({
      runId: run.runId, cwd, noFollow: true,
      __testIsTTY: false,
      __testWriteStdout: s => captured.push(s),
    });
    assert.equal(r.exit, 0);
    assert.match(captured.join(''), /no cap/);
    cleanup(cwd);
  });

  it('also accepts the plural `budgets` config alias', async () => {
    const cwd = tmpCwd();
    const run = await createRun({
      cwd, phases: ['spec'],
      config: { budgets: { perRunUSD: 50 } },
    });
    await run.lock.release();
    const captured: string[] = [];
    const r = await runRunsWatch({
      runId: run.runId, cwd, noFollow: true,
      __testIsTTY: false,
      __testWriteStdout: s => captured.push(s),
    });
    assert.equal(r.exit, 0);
    assert.match(captured.join(''), /\$50\.00/);
    cleanup(cwd);
  });
});

// ----------------------------------------------------------------------------
// 7. ANSI behavior.
// ----------------------------------------------------------------------------

describe('runs watch ANSI behavior', () => {
  it('strips ANSI when --no-color is passed even on a TTY', async () => {
    const cwd = tmpCwd();
    const run = await createRun({ cwd, phases: ['spec'] });
    await run.lock.release();
    const captured: string[] = [];
    await runRunsWatch({
      runId: run.runId, cwd, noFollow: true, noColor: true,
      __testIsTTY: true,
      __testWriteStdout: s => captured.push(s),
    });
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(captured.join(''), /\x1b\[/);
    cleanup(cwd);
  });

  it('emits ANSI when stdout is a TTY and --no-color is not set', async () => {
    const cwd = tmpCwd();
    const run = await createRun({ cwd, phases: ['spec'] });
    appendEvent(run.runDir, {
      event: 'phase.start', phase: 'spec', phaseIdx: 0,
      idempotent: false, hasSideEffects: false, attempt: 1,
    }, { writerId: run.lock.writerId, runId: run.runId });
    await run.lock.release();
    const captured: string[] = [];
    // Save NO_COLOR if set so we can restore it
    const savedNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      await runRunsWatch({
        runId: run.runId, cwd, noFollow: true,
        __testIsTTY: true,
        __testWriteStdout: s => captured.push(s),
      });
      // eslint-disable-next-line no-control-regex
      assert.match(captured.join(''), /\x1b\[/);
    } finally {
      if (savedNoColor !== undefined) process.env.NO_COLOR = savedNoColor;
    }
    cleanup(cwd);
  });
});

// ----------------------------------------------------------------------------
// 8. Already-terminated short-circuit on live tail.
// ----------------------------------------------------------------------------

describe('runs watch already-terminated short-circuit', () => {
  it('exits immediately when the watched run has already completed', async () => {
    const cwd = tmpCwd();
    const run = await createRun({ cwd, phases: ['spec'] });
    appendEvent(run.runDir, {
      event: 'run.complete', status: 'success', totalCostUSD: 0, durationMs: 100,
    }, { writerId: run.lock.writerId, runId: run.runId });
    await run.lock.release();

    const captured: string[] = [];
    // No --no-follow; the watcher should drain and exit on its own because
    // the terminal event is already on disk.
    const start = Date.now();
    const r = await runRunsWatch({
      runId: run.runId, cwd,
      __testIsTTY: false,
      __testWriteStdout: s => captured.push(s),
      __testPollIntervalMs: 5000, // long poll — we should NOT hit it
    });
    const elapsed = Date.now() - start;
    assert.equal(r.exit, 0);
    assert.ok(elapsed < 1000, `watcher should short-circuit fast, took ${elapsed}ms`);
    assert.match(captured.join(''), /run\.complete/);
    cleanup(cwd);
  });
});
