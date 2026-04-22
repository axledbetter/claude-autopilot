import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendCostLog } from '../src/core/persist/cost-log.ts';
import { runCosts } from '../src/cli/costs.ts';

let tmpDir: string;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-costs-cli-')); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('runCosts', () => {
  it('exits 0 with no log file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-costs-empty-'));
    const code = await runCosts(dir);
    assert.equal(code, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 with entries and prints without throwing', async () => {
    const entry = {
      timestamp: new Date().toISOString(),
      files: 5, inputTokens: 1200, outputTokens: 300, costUSD: 0.0045, durationMs: 1800,
    };
    appendCostLog(tmpDir, entry);
    appendCostLog(tmpDir, { ...entry, files: 3, costUSD: 0.002 });
    const code = await runCosts(tmpDir);
    assert.equal(code, 0);
  });
});
