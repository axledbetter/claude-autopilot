import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSetup } from '../src/cli/setup.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-setup-'));
}

describe('runSetup', () => {
  it('writes guardrail.config.yaml with testCommand (appends only when preset omits it)', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\ngo 1.22\n');
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'guardrail.config.yaml'), 'configVersion: 1\nreviewEngine: { adapter: codex }\n');
    await runSetup({ cwd: dir, skipHook: true });
    const content = fs.readFileSync(path.join(dir, 'guardrail.config.yaml'), 'utf8');
    // 5.0.6 — setup uses the package's bundled preset (which has its own
    // testCommand for go/python/python-fastapi/rails-postgres). The append-on-
    // detect path only runs when the preset omits testCommand; either way,
    // exactly one `testCommand:` key must be present in the final config.
    const matches = content.match(/^testCommand\s*:/gm) ?? [];
    assert.equal(matches.length, 1, `Expected exactly one testCommand line, got ${matches.length}:\n${content}`);
    assert.ok(/^testCommand\s*:\s*"?go test/m.test(content), `Expected go test command, got:\n${content}`);
    fs.rmSync(dir, { recursive: true });
  });

  it('errors if guardrail.config.yaml already exists without --force', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), 'configVersion: 1\n');
    await assert.rejects(
      () => runSetup({ cwd: dir, skipHook: true }),
      /already exists/,
    );
    fs.rmSync(dir, { recursive: true });
  });

  it('overwrites with --force', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'guardrail.config.yaml'), 'old content\n');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\ngo 1.22\n');
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'guardrail.config.yaml'), 'configVersion: 1\n');
    await runSetup({ cwd: dir, force: true, skipHook: true });
    const content = fs.readFileSync(path.join(dir, 'guardrail.config.yaml'), 'utf8');
    assert.ok(content.includes('testCommand:'));
    fs.rmSync(dir, { recursive: true });
  });
});
