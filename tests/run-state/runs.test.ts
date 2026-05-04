import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRun,
  gcRuns,
  indexPath,
  listRuns,
  rebuildIndex,
  runDirFor,
  runsRoot,
} from '../../src/core/run-state/runs.ts';
import { readEvents } from '../../src/core/run-state/events.ts';
import { statePath } from '../../src/core/run-state/state.ts';
import { ulid } from '../../src/core/run-state/ulid.ts';

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-runs-'));
}

describe('createRun', () => {
  it('creates a run dir, writes state.json + run.start event, holds the lock', async () => {
    const cwd = tmpCwd();
    const result = await createRun({ cwd, phases: ['plan', 'impl'] });
    assert.equal(result.state.phases.length, 2);
    assert.ok(fs.existsSync(statePath(result.runDir)));
    const { events } = readEvents(result.runDir);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, 'run.start');
    assert.equal(result.state.lastEventSeq, 1);
    // Lock is held — we can confirm via the lock-meta sidecar.
    assert.ok(fs.existsSync(path.join(result.runDir, '.lock-meta.json')));
    await result.lock.release();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects empty phases array', async () => {
    const cwd = tmpCwd();
    await assert.rejects(
      createRun({ cwd, phases: [] }),
      /non-empty/,
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('writes config to the snapshot', async () => {
    const cwd = tmpCwd();
    const result = await createRun({
      cwd,
      phases: ['p'],
      config: { budgets: { perRunUSD: 25 } },
    });
    assert.deepEqual(result.state.config, { budgets: { perRunUSD: 25 } });
    await result.lock.release();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('listRuns', () => {
  it('returns empty array when no runs exist', () => {
    const cwd = tmpCwd();
    assert.deepEqual(listRuns(cwd), []);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('lists runs newest-first', async () => {
    const cwd = tmpCwd();
    const a = await createRun({ cwd, phases: ['p'] });
    await new Promise(r => setTimeout(r, 5));
    const b = await createRun({ cwd, phases: ['p'] });
    await new Promise(r => setTimeout(r, 5));
    const c = await createRun({ cwd, phases: ['p'] });
    const runs = listRuns(cwd, { rebuild: true });
    assert.equal(runs.length, 3);
    assert.equal(runs[0]!.runId, c.runId);
    assert.equal(runs[2]!.runId, a.runId);
    await a.lock.release();
    await b.lock.release();
    await c.lock.release();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('rebuilds when index.json is missing', async () => {
    const cwd = tmpCwd();
    const r = await createRun({ cwd, phases: ['p'] });
    await r.lock.release();
    // Delete the index.
    fs.unlinkSync(indexPath(cwd));
    const runs = listRuns(cwd);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.runId, r.runId);
    // Rebuilt — index.json is back.
    assert.ok(fs.existsSync(indexPath(cwd)));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('rebuilds the listing when state.json is corrupt (uses events replay)', async () => {
    const cwd = tmpCwd();
    const r = await createRun({ cwd, phases: ['p'] });
    await r.lock.release();
    // Corrupt state.json so listing falls back to replay.
    fs.writeFileSync(statePath(r.runDir), 'garbage', 'utf8');
    const runs = listRuns(cwd, { rebuild: true });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.runId, r.runId);
    assert.equal(runs[0]!.recovered, true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('skips suspicious runs (non-ULID, unreadable) instead of crashing', async () => {
    const cwd = tmpCwd();
    fs.mkdirSync(runsRoot(cwd), { recursive: true });
    // Plant a non-ULID dir with no state and no events.
    fs.mkdirSync(path.join(runsRoot(cwd), 'NOT-A-ULID'), { recursive: true });
    const idx = rebuildIndex(cwd);
    // The bogus dir gets included as a recovered/empty entry OR skipped —
    // both behaviors are acceptable; we just assert no throw.
    assert.ok(Array.isArray(idx.runs));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('gcRuns', () => {
  it('keeps active runs', async () => {
    const cwd = tmpCwd();
    const r = await createRun({ cwd, phases: ['p'] });
    const result = gcRuns(cwd, { olderThanDays: 0 });
    assert.deepEqual(result.deleted, []);
    assert.ok(result.kept.includes(r.runId));
    await r.lock.release();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('dryRun reports deletions but does not touch disk', () => {
    const cwd = tmpCwd();
    // Plant an old run dir manually (terminal status, end time long ago).
    const ancient = ulid(Date.now() - 90 * 86_400_000);
    const dir = runDirFor(cwd, ancient);
    fs.mkdirSync(dir, { recursive: true });
    const state = {
      schema_version: 1,
      runId: ancient,
      startedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      endedAt: new Date(Date.now() - 89 * 86_400_000).toISOString(),
      status: 'success',
      phases: [],
      currentPhaseIdx: 0,
      totalCostUSD: 0,
      lastEventSeq: 0,
      writerId: { pid: 0, hostHash: '' },
      cwd,
    };
    fs.writeFileSync(statePath(dir), JSON.stringify(state), 'utf8');

    const dry = gcRuns(cwd, { olderThanDays: 30, dryRun: true });
    assert.deepEqual(dry.deleted, [ancient]);
    assert.ok(fs.existsSync(dir));

    const real = gcRuns(cwd, { olderThanDays: 30 });
    assert.deepEqual(real.deleted, [ancient]);
    assert.equal(fs.existsSync(dir), false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('refuses to follow symlinks (lstat safety)', () => {
    const cwd = tmpCwd();
    const root = runsRoot(cwd);
    fs.mkdirSync(root, { recursive: true });
    // Create a target dir OUTSIDE runs/ that we don't want deleted.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'do not delete', 'utf8');
    // Symlink it inside runs/ as a fake "old run".
    const linkName = ulid(Date.now() - 90 * 86_400_000);
    try {
      fs.symlinkSync(outside, path.join(root, linkName), 'dir');
    } catch (e) {
      // Some test environments (Windows w/o admin) can't symlink; skip.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
        return;
      }
      throw e;
    }
    const result = gcRuns(cwd, { olderThanDays: 30 });
    assert.ok(result.skippedUnsafe.includes(linkName));
    // The outside dir is untouched.
    assert.ok(fs.existsSync(path.join(outside, 'sentinel.txt')));
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('keeps recently-completed runs', () => {
    const cwd = tmpCwd();
    const recent = ulid(Date.now() - 1_000); // 1s ago
    const dir = runDirFor(cwd, recent);
    fs.mkdirSync(dir, { recursive: true });
    const state = {
      schema_version: 1, runId: recent,
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      endedAt: new Date(Date.now() - 500).toISOString(),
      status: 'success',
      phases: [], currentPhaseIdx: 0, totalCostUSD: 0,
      lastEventSeq: 0, writerId: { pid: 0, hostHash: '' }, cwd,
    };
    fs.writeFileSync(statePath(dir), JSON.stringify(state), 'utf8');
    const r = gcRuns(cwd, { olderThanDays: 30 });
    assert.deepEqual(r.deleted, []);
    assert.ok(r.kept.includes(recent));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
