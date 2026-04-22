import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendCostLog, readCostLog } from '../src/core/persist/cost-log.ts';

let tmpDir: string;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cost-')); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('cost log', () => {
  it('returns empty array when no file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cost-empty-'));
    assert.deepEqual(readCostLog(dir), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a single entry', () => {
    const entry = { timestamp: '2026-04-22T00:00:00Z', files: 3, inputTokens: 1000, outputTokens: 200, costUSD: 0.0012, durationMs: 1500 };
    appendCostLog(tmpDir, entry);
    const log = readCostLog(tmpDir);
    assert.equal(log.length, 1);
    assert.equal(log[0]!.files, 3);
    assert.equal(log[0]!.costUSD, 0.0012);
  });

  it('appends multiple entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cost-multi-'));
    const entry = { timestamp: '2026-04-22T00:00:00Z', files: 1, inputTokens: 100, outputTokens: 50, costUSD: 0.001, durationMs: 500 };
    appendCostLog(dir, entry);
    appendCostLog(dir, { ...entry, files: 2 });
    const log = readCostLog(dir);
    assert.equal(log.length, 2);
    assert.equal(log[1]!.files, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips corrupt lines gracefully', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cost-corrupt-'));
    fs.mkdirSync(path.join(dir, '.autopilot-cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.autopilot-cache', 'costs.jsonl'),
      'not json\n{"timestamp":"x","files":1,"inputTokens":0,"outputTokens":0,"costUSD":0,"durationMs":0}\n', 'utf8');
    const log = readCostLog(dir);
    assert.equal(log.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
