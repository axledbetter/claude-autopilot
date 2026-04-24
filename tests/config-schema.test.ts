import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../src/core/config/loader.ts';

async function writeConfig(dir: string, content: string): Promise<string> {
  const p = path.join(dir, 'guardrail.config.yaml');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('config schema validation', () => {
  it('accepts a minimal valid config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-schema-'));
    const p = await writeConfig(dir, 'configVersion: 1\n');
    const config = await loadConfig(p);
    assert.equal(config.configVersion, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unknown top-level key with clear message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-schema-'));
    const p = await writeConfig(dir, 'configVersion: 1\nunknownKey: foo\n');
    await assert.rejects(
      () => loadConfig(p),
      (err: Error) => {
        assert.ok(err.message.includes('unknownKey'), `expected "unknownKey" in: ${err.message}`);
        return true;
      },
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects invalid reviewStrategy with allowed values listed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-schema-'));
    const p = await writeConfig(dir, 'configVersion: 1\nreviewStrategy: turbo\n');
    await assert.rejects(
      () => loadConfig(p),
      (err: Error) => {
        assert.ok(err.message.includes('reviewStrategy'), `expected "reviewStrategy" in: ${err.message}`);
        return true;
      },
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts all valid reviewStrategy values', async () => {
    for (const strategy of ['auto', 'single-pass', 'file-level', 'diff', 'auto-diff']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-schema-'));
      const p = await writeConfig(dir, `configVersion: 1\nreviewStrategy: ${strategy}\n`);
      const config = await loadConfig(p);
      assert.equal(config.reviewStrategy, strategy);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts ignore: as string array', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-schema-'));
    const p = await writeConfig(dir, 'configVersion: 1\nignore:\n  - tests/**\n');
    const config = await loadConfig(p);
    assert.deepEqual(config.ignore, ['tests/**']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts ignore: as object array', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-schema-'));
    const p = await writeConfig(dir, 'configVersion: 1\nignore:\n  - rule: hardcoded-secrets\n    path: src/vendor/**\n');
    const config = await loadConfig(p);
    assert.deepEqual(config.ignore, [{ rule: 'hardcoded-secrets', path: 'src/vendor/**' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects testCommand as number', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-schema-'));
    const p = await writeConfig(dir, 'configVersion: 1\ntestCommand: 42\n');
    await assert.rejects(() => loadConfig(p), /testCommand/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Ensures every TS GuardrailConfig field that users set from YAML has a matching
  // schema entry — without this, `additionalProperties: false` at the top level
  // silently rejects config that looked fine in TypeScript.

  it('accepts pipeline.runReviewOnStaticFail from YAML', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-schema-'));
    const p = await writeConfig(dir, [
      'configVersion: 1',
      'pipeline:',
      '  runReviewOnStaticFail: false',
      '  runReviewOnTestFail: true',
      '',
    ].join('\n'));
    const config = await loadConfig(p);
    assert.deepEqual(config.pipeline, {
      runReviewOnStaticFail: false,
      runReviewOnTestFail: true,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unknown pipeline key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-schema-'));
    const p = await writeConfig(dir, [
      'configVersion: 1',
      'pipeline:',
      '  runReviewOnMondays: true',
      '',
    ].join('\n'));
    await assert.rejects(() => loadConfig(p), /runReviewOnMondays/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
