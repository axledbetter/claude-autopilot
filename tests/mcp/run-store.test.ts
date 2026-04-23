import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveRun, loadRun, checksumFile, pruneOldRuns } from '../../src/core/mcp/run-store.ts';
import type { Finding } from '../../src/core/findings/types.ts';

const FINDING: Finding = {
  id: 'f1', source: 'static-rules', severity: 'critical',
  category: 'security', file: 'src/foo.ts', line: 10,
  message: 'test finding', protectedPath: false, createdAt: new Date().toISOString(),
};

describe('run-store', () => {
  let tmp: string;

  it('saves and loads a run', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-'));
    const runId = 'test-run-id';
    saveRun(tmp, runId, [FINDING], { 'src/foo.ts': 'abc123' });
    const loaded = loadRun(tmp, runId);
    assert.ok(loaded);
    assert.equal(loaded.run_id, runId);
    assert.equal(loaded.findings.length, 1);
    assert.equal(loaded.fileChecksums['src/foo.ts'], 'abc123');
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns null for missing run_id', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-'));
    const result = loadRun(tmp, 'nonexistent');
    assert.equal(result, null);
    fs.rmSync(tmp, { recursive: true });
  });

  it('checksumFile returns hex string for existing file', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-'));
    const file = path.join(tmp, 'test.ts');
    fs.writeFileSync(file, 'hello');
    const sum = checksumFile(file);
    assert.match(sum, /^[0-9a-f]{64}$/);
    fs.rmSync(tmp, { recursive: true });
  });

  it('checksumFile returns empty string for missing file', () => {
    assert.equal(checksumFile('/nonexistent/file.ts'), '');
  });

  it('pruneOldRuns removes runs older than maxAgeMs', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-'));
    saveRun(tmp, 'old-run', [], {});
    const runDir = path.join(tmp, '.guardrail-cache', 'runs');
    const oldFile = path.join(runDir, 'old-run.json');
    // backdate the file
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldTime, oldTime);
    saveRun(tmp, 'new-run', [], {});
    pruneOldRuns(tmp, 24 * 60 * 60 * 1000);
    assert.equal(fs.existsSync(oldFile), false);
    assert.ok(fs.existsSync(path.join(runDir, 'new-run.json')));
    fs.rmSync(tmp, { recursive: true });
  });

  it('rejects run_id with path traversal', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-traversal-'));
    assert.throws(() => saveRun(tmp, '../escape', [FINDING], {}), /invalid_run_id|expected alphanumeric/);
    assert.throws(() => loadRun(tmp, '../../etc/passwd'), /invalid_run_id|expected alphanumeric/);
    assert.throws(() => loadRun(tmp, 'foo/bar'), /invalid_run_id|expected alphanumeric/);
    assert.throws(() => loadRun(tmp, ''), /invalid_run_id|expected alphanumeric/);
    fs.rmSync(tmp, { recursive: true });
  });

  it('accepts UUID-style run_ids', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-uuid-'));
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    saveRun(tmp, uuid, [FINDING], {});
    const loaded = loadRun(tmp, uuid);
    assert.ok(loaded, 'UUID-style run_id should load successfully');
    fs.rmSync(tmp, { recursive: true });
  });
});
