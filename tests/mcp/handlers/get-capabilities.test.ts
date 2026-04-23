import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleGetCapabilities } from '../../../src/core/mcp/handlers/get-capabilities.ts';
import type { GuardrailConfig } from '../../../src/core/config/types.ts';

const BASE_CONFIG: GuardrailConfig = { configVersion: 1 };

describe('handleGetCapabilities', () => {
  let tmp: string;

  it('returns schema_version, adapter, guardrailVersion', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-test-'));
    const result = await handleGetCapabilities({ cwd: tmp }, BASE_CONFIG, 'claude');
    assert.equal(result.schema_version, 1);
    assert.equal(result.adapter, 'claude');
    assert.ok(typeof result.guardrailVersion === 'string');
    assert.ok(Array.isArray(result.enabledRules));
    assert.ok(typeof result.writeable === 'boolean');
    assert.ok(typeof result.gitAvailable === 'boolean');
    assert.ok(typeof result.testCommandConfigured === 'boolean');
    fs.rmSync(tmp, { recursive: true });
  });

  it('testCommandConfigured is true when config has testCommand', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-test-'));
    const cfg: GuardrailConfig = { configVersion: 1, testCommand: 'npm test' };
    const result = await handleGetCapabilities({ cwd: tmp }, cfg, 'gemini');
    assert.equal(result.testCommandConfigured, true);
    fs.rmSync(tmp, { recursive: true });
  });

  it('testCommandConfigured is false when config has no testCommand', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-test-'));
    const cfg: GuardrailConfig = { configVersion: 1 };
    const result = await handleGetCapabilities({ cwd: tmp }, cfg, 'claude');
    assert.equal(result.testCommandConfigured, false);
    fs.rmSync(tmp, { recursive: true });
  });

  it('enabledRules reflects config staticRules (strings)', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-test-'));
    const cfg: GuardrailConfig = { configVersion: 1, staticRules: ['console-log', 'sql-injection'] };
    const result = await handleGetCapabilities({ cwd: tmp }, cfg, 'claude');
    assert.deepEqual(result.enabledRules, ['console-log', 'sql-injection']);
    fs.rmSync(tmp, { recursive: true });
  });

  it('enabledRules reflects config staticRules (object references)', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-test-'));
    const cfg: GuardrailConfig = {
      configVersion: 1,
      staticRules: [
        'console-log',
        { adapter: 'sql-injection', options: { severity: 'high' } },
      ],
    };
    const result = await handleGetCapabilities({ cwd: tmp }, cfg, 'claude');
    assert.deepEqual(result.enabledRules, ['console-log', 'sql-injection']);
    fs.rmSync(tmp, { recursive: true });
  });

  it('enabledRules is empty when no staticRules', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-test-'));
    const result = await handleGetCapabilities({ cwd: tmp }, BASE_CONFIG, 'claude');
    assert.deepEqual(result.enabledRules, []);
    fs.rmSync(tmp, { recursive: true });
  });

  it('gitAvailable reflects git availability', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-test-'));
    const result = await handleGetCapabilities({ cwd: tmp }, BASE_CONFIG, 'claude');
    // Non-git directory should return false
    assert.equal(result.gitAvailable, false);
    fs.rmSync(tmp, { recursive: true });
  });
});
