import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleValidateFix } from '../../../src/core/mcp/handlers/validate-fix.ts';
import type { GuardrailConfig } from '../../../src/core/config/types.ts';

describe('handleValidateFix', () => {
  let tmp: string;

  it('returns passed:true when no testCommand configured', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-test-'));
    const config: GuardrailConfig = { configVersion: 1 };
    const result = await handleValidateFix({ cwd: tmp }, config);
    assert.equal(result.schema_version, 1);
    assert.equal(result.passed, true);
    assert.ok(typeof result.durationMs === 'number');
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns passed:true for passing testCommand', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-test-'));
    const config: GuardrailConfig = { configVersion: 1, testCommand: 'echo ok' };
    const result = await handleValidateFix({ cwd: tmp }, config);
    assert.equal(result.passed, true);
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns passed:false for failing testCommand', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-test-'));
    const config: GuardrailConfig = { configVersion: 1, testCommand: 'false' };
    const result = await handleValidateFix({ cwd: tmp }, config);
    assert.equal(result.passed, false);
    fs.rmSync(tmp, { recursive: true });
  });
});
