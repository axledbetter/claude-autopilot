import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleGetFindings } from '../../../src/core/mcp/handlers/get-findings.ts';
import { saveRun } from '../../../src/core/mcp/run-store.ts';
import type { Finding } from '../../../src/core/findings/types.ts';

const FINDINGS: Finding[] = [
  { id: 'f1', source: 'static-rules', severity: 'critical', category: 'security', file: 'a.ts', line: 1, message: 'critical issue', protectedPath: false, createdAt: new Date().toISOString() },
  { id: 'f2', source: 'static-rules', severity: 'warning', category: 'style', file: 'b.ts', line: 2, message: 'warning issue', protectedPath: false, createdAt: new Date().toISOString() },
  { id: 'f3', source: 'static-rules', severity: 'note', category: 'style', file: 'c.ts', line: 3, message: 'note issue', protectedPath: false, createdAt: new Date().toISOString() },
];

describe('handleGetFindings', () => {
  let tmp: string;

  it('returns all findings for a run_id', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'get-findings-test-'));
    saveRun(tmp, 'run1', FINDINGS, {});
    const result = await handleGetFindings({ run_id: 'run1', cwd: tmp });
    assert.equal(result.schema_version, 1);
    assert.equal(result.findings.length, 3);
    assert.ok(typeof result.cachedAt === 'string');
    fs.rmSync(tmp, { recursive: true });
  });

  it('filters by severity critical returns only critical', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'get-findings-test-'));
    saveRun(tmp, 'run2', FINDINGS, {});
    const result = await handleGetFindings({ run_id: 'run2', severity: 'critical', cwd: tmp });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'critical');
    fs.rmSync(tmp, { recursive: true });
  });

  it('filters by severity warning returns critical+warning', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'get-findings-test-'));
    saveRun(tmp, 'run3', FINDINGS, {});
    const result = await handleGetFindings({ run_id: 'run3', severity: 'warning', cwd: tmp });
    assert.equal(result.findings.length, 2);
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws with run_not_found for missing run_id', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'get-findings-test-'));
    await assert.rejects(
      () => handleGetFindings({ run_id: 'nonexistent', cwd: tmp }),
      /run_not_found/,
    );
    fs.rmSync(tmp, { recursive: true });
  });
});
