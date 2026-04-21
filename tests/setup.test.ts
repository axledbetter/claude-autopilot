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
  it('writes autopilot.config.yaml with detected testCommand', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\ngo 1.22\n');
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'autopilot.config.yaml'), 'configVersion: 1\nreviewEngine: { adapter: codex }\n');
    await runSetup({ cwd: dir, skipHook: true });
    const content = fs.readFileSync(path.join(dir, 'autopilot.config.yaml'), 'utf8');
    assert.ok(content.includes('testCommand: "go test ./..."'), `Expected testCommand in output, got:\n${content}`);
    fs.rmSync(dir, { recursive: true });
  });

  it('errors if autopilot.config.yaml already exists without --force', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'autopilot.config.yaml'), 'configVersion: 1\n');
    await assert.rejects(
      () => runSetup({ cwd: dir, skipHook: true }),
      /already exists/,
    );
    fs.rmSync(dir, { recursive: true });
  });

  it('overwrites with --force', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'autopilot.config.yaml'), 'old content\n');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\ngo 1.22\n');
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'autopilot.config.yaml'), 'configVersion: 1\n');
    await runSetup({ cwd: dir, force: true, skipHook: true });
    const content = fs.readFileSync(path.join(dir, 'autopilot.config.yaml'), 'utf8');
    assert.ok(content.includes('testCommand:'));
    fs.rmSync(dir, { recursive: true });
  });
});
