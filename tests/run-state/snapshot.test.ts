import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  phaseSnapshotPath,
  phasesDir,
  readPhaseSnapshot,
  writePhaseSnapshot,
} from '../../src/core/run-state/snapshot.ts';
import {
  RUN_STATE_SCHEMA_VERSION,
  type PhaseSnapshot,
} from '../../src/core/run-state/types.ts';
import { GuardrailError } from '../../src/core/errors.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-snap-'));
}

function makeSnapshot(name: string, index = 0): PhaseSnapshot {
  return {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    name,
    index,
    status: 'succeeded',
    idempotent: false,
    hasSideEffects: false,
    costUSD: 0,
    attempts: 1,
    artifacts: [],
    externalRefs: [],
  };
}

describe('writePhaseSnapshot', () => {
  it('writes phases/<name>.json atomically (no leftover .tmp)', () => {
    const dir = tmp();
    writePhaseSnapshot(dir, makeSnapshot('plan'));
    assert.ok(fs.existsSync(phaseSnapshotPath(dir, 'plan')));
    const tmpFiles = fs.readdirSync(phasesDir(dir)).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(tmpFiles, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips via readPhaseSnapshot', () => {
    const dir = tmp();
    const snap = makeSnapshot('implement', 2);
    snap.costUSD = 0.42;
    snap.lastError = 'oops';
    writePhaseSnapshot(dir, snap);
    const got = readPhaseSnapshot(dir, 'implement');
    assert.equal(got?.costUSD, 0.42);
    assert.equal(got?.lastError, 'oops');
    assert.equal(got?.index, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readPhaseSnapshot returns null when missing', () => {
    const dir = tmp();
    assert.equal(readPhaseSnapshot(dir, 'never-written'), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readPhaseSnapshot throws corrupted_state on garbage', () => {
    const dir = tmp();
    fs.mkdirSync(phasesDir(dir), { recursive: true });
    fs.writeFileSync(phaseSnapshotPath(dir, 'bad'), '{not json', 'utf8');
    assert.throws(
      () => readPhaseSnapshot(dir, 'bad'),
      (err: unknown) => err instanceof GuardrailError && err.code === 'corrupted_state',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('overwriting an existing snapshot leaves no .tmp behind', () => {
    const dir = tmp();
    writePhaseSnapshot(dir, makeSnapshot('plan'));
    const updated = makeSnapshot('plan');
    updated.costUSD = 9.99;
    writePhaseSnapshot(dir, updated);
    const got = readPhaseSnapshot(dir, 'plan');
    assert.equal(got?.costUSD, 9.99);
    const tmpFiles = fs.readdirSync(phasesDir(dir)).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(tmpFiles, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects phase names containing path separators or special chars', () => {
    const dir = tmp();
    for (const bad of ['../escape', 'has/slash', 'has\\back', 'has space', '']) {
      assert.throws(
        () => writePhaseSnapshot(dir, makeSnapshot(bad)),
        (err: unknown) => err instanceof GuardrailError && err.code === 'invalid_config',
        `name "${bad}" should be rejected`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
