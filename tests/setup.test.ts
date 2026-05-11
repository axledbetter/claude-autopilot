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

  // v7.1.7 — day-1 polish (benchmark-driven)

  it('appends node_modules/ + .guardrail-cache/ to existing .gitignore (idempotent)', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module ex.com/x\ngo 1.22\n');
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'guardrail.config.yaml'), 'configVersion: 1\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env.local\n');
    await runSetup({ cwd: dir, skipHook: true });
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(gi.includes('.env.local'), 'preserves existing entries');
    assert.ok(gi.includes('node_modules/'), 'adds node_modules/');
    assert.ok(gi.includes('.guardrail-cache/'), 'adds .guardrail-cache/');
    // Idempotency: re-running shouldn't duplicate.
    fs.rmSync(path.join(dir, 'guardrail.config.yaml'));
    await runSetup({ cwd: dir, skipHook: true });
    const gi2 = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    const matches = gi2.match(/node_modules\//g) ?? [];
    assert.equal(matches.length, 1, `node_modules/ should appear once, got ${matches.length}:\n${gi2}`);
    fs.rmSync(dir, { recursive: true });
  });

  it('creates .gitignore from scratch when missing', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module ex.com/x\ngo 1.22\n');
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'guardrail.config.yaml'), 'configVersion: 1\n');
    assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false);
    await runSetup({ cwd: dir, skipHook: true });
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(gi.includes('node_modules/'));
    assert.ok(gi.includes('.guardrail-cache/'));
    fs.rmSync(dir, { recursive: true });
  });

  it('writes starter CLAUDE.md when missing, including detected stack + test command', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module ex.com/x\ngo 1.22\n');
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'guardrail.config.yaml'), 'configVersion: 1\n');
    await runSetup({ cwd: dir, skipHook: true });
    const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.startsWith('# CLAUDE.md'), 'has header');
    assert.ok(/Detected:.*Go/i.test(claudeMd), 'mentions Go stack');
    assert.ok(claudeMd.includes('go test'), 'mentions test command');
    assert.ok(claudeMd.includes('Conventional Commits'), 'commit-message convention present');
    assert.ok(claudeMd.includes('TODO:'), 'has TODOs for the operator to fill in');
    fs.rmSync(dir, { recursive: true });
  });

  it('does NOT overwrite existing CLAUDE.md', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module ex.com/x\ngo 1.22\n');
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'guardrail.config.yaml'), 'configVersion: 1\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# my own claude doc, do not touch\n');
    await runSetup({ cwd: dir, skipHook: true });
    const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.equal(claudeMd, '# my own claude doc, do not touch\n', 'existing CLAUDE.md preserved');
    fs.rmSync(dir, { recursive: true });
  });

  // v7.1.9 — Generic+low-confidence detection prompt (benchmark-driven)
  it('emits "scaffold a stack file first" hint on Generic+low-confidence detection', async () => {
    const dir = makeTmp();
    // No package.json, go.mod, etc. → detector returns generic preset.
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'generic');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'guardrail.config.yaml'), 'configVersion: 1\n');

    // Capture stdout to verify the new hint appears.
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      await runSetup({ cwd: dir, skipHook: true });
    } finally {
      console.log = origLog;
    }
    const output = lines.join('\n');
    assert.match(output, /Stack detection: Generic \(low confidence\)/i, 'surfaces detection state');
    assert.match(output, /npm init -y/, 'mentions npm init shortcut');
    assert.match(output, /setup --force/, 'mentions re-running setup');
    fs.rmSync(dir, { recursive: true });
  });

  it('does NOT emit Generic-stack hint when detection is high-confidence', async () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module ex.com/x\ngo 1.22\n');
    const presetDir = path.join(dir, 'node_modules', '@delegance', 'claude-autopilot', 'presets', 'go');
    fs.mkdirSync(presetDir, { recursive: true });
    fs.writeFileSync(path.join(presetDir, 'guardrail.config.yaml'), 'configVersion: 1\n');
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      await runSetup({ cwd: dir, skipHook: true });
    } finally {
      console.log = origLog;
    }
    const output = lines.join('\n');
    assert.equal(output.includes('Stack detection: Generic (low confidence)'), false,
      'hint does NOT appear for high-confidence Go detection');
    fs.rmSync(dir, { recursive: true });
  });
});
