import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInternalCli } from '../../src/core/run-state/cli-internal.ts';
import { createRun } from '../../src/core/run-state/runs.ts';
import { readEvents } from '../../src/core/run-state/events.ts';

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cli-internal-'));
}

describe('runInternalCli — log-phase-event', () => {
  it('appends a phase.cost event to an existing run and exits 0', async () => {
    const cwd = tmpRepo();
    const created = await createRun({ cwd, phases: ['plan'] });
    try {
      const eventJson = JSON.stringify({
        event: 'phase.cost',
        phase: 'plan',
        phaseIdx: 0,
        provider: 'anthropic',
        inputTokens: 1200,
        outputTokens: 3400,
        costUSD: 0.07,
      });
      const result = await runInternalCli({
        cwd,
        args: ['log-phase-event', '--run-id', created.runId, '--event', eventJson],
      });
      assert.equal(result.exit, 0, `unexpected exit ${result.exit}: ${result.stderr.join(' | ')}`);
      // stdout includes the seq + event kind for diagnosis.
      assert.match(result.stdout.join('\n'), /appended seq=\d+ event=phase\.cost/);

      const { events } = readEvents(created.runDir);
      const cost = events.find(e => e.event === 'phase.cost');
      assert.ok(cost, 'phase.cost event missing from log');
      assert.equal((cost as { provider: string }).provider, 'anthropic');
    } finally {
      await created.lock.release();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('exits 1 when --run-id is missing', async () => {
    const cwd = tmpRepo();
    const result = await runInternalCli({
      cwd,
      args: ['log-phase-event', '--event', '{"event":"run.warning","message":"hi"}'],
    });
    assert.equal(result.exit, 1);
    assert.match(result.stderr.join('\n'), /--run-id is required/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('exits 1 when --event is not valid JSON', async () => {
    const cwd = tmpRepo();
    const result = await runInternalCli({
      cwd,
      args: ['log-phase-event', '--run-id', 'TESTRUN', '--event', '{not-json'],
    });
    assert.equal(result.exit, 1);
    assert.match(result.stderr.join('\n'), /not valid JSON/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('exits 1 when --event lacks an "event" string field', async () => {
    const cwd = tmpRepo();
    const result = await runInternalCli({
      cwd,
      args: ['log-phase-event', '--run-id', 'TESTRUN', '--event', '{"phase":"plan"}'],
    });
    assert.equal(result.exit, 1);
    assert.match(
      result.stderr.join('\n'),
      /must be an object with an "event" string field/,
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('exits 1 with help on unknown verb', async () => {
    const cwd = tmpRepo();
    const result = await runInternalCli({
      cwd,
      args: ['mystery-verb'],
    });
    assert.equal(result.exit, 1);
    assert.match(result.stderr.join('\n'), /unknown verb "mystery-verb"/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('prints help with --help and exits 0', async () => {
    const cwd = tmpRepo();
    const result = await runInternalCli({ cwd, args: ['--help'] });
    assert.equal(result.exit, 0);
    assert.match(result.stdout.join('\n'), /log-phase-event/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
