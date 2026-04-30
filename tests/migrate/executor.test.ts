import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeCommand, parseLegacyCommand, resolveExecutable } from '../../src/core/migrate/executor.ts';
import type { CommandSpec } from '../../src/core/migrate/types.ts';

let tmpDir: string;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-'));
});
after(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

describe('executeCommand — structured argv', () => {
  it('runs successfully and captures stdout', async () => {
    const spec: CommandSpec = { exec: 'node', args: ['-e', 'process.stdout.write("hello")'] };
    const r = await executeCommand(spec, { cwd: tmpDir });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /hello/);
  });

  it('captures stderr', async () => {
    const spec: CommandSpec = { exec: 'node', args: ['-e', 'process.stderr.write("err"); process.exit(1)'] };
    const r = await executeCommand(spec, { cwd: tmpDir });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /err/);
  });

  it('does NOT interpret shell metacharacters (no shell)', async () => {
    // If shell:true were used, "$(echo PWNED)" would expand. With shell:false,
    // it's passed as a literal arg.
    const spec: CommandSpec = { exec: 'node', args: ['-e', 'process.stdout.write(process.argv[1])', '$(echo PWNED)'] };
    const r = await executeCommand(spec, { cwd: tmpDir });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '$(echo PWNED)');
  });

  it('passes env vars through and never on command line', async () => {
    const spec: CommandSpec = { exec: 'node', args: ['-e', 'process.stdout.write(process.env.SECRET || "missing")'] };
    const r = await executeCommand(spec, { cwd: tmpDir, env: { SECRET: 'hush' } });
    assert.equal(r.stdout, 'hush');
  });

  it('respects cwd', async () => {
    const spec: CommandSpec = { exec: 'node', args: ['-e', 'process.stdout.write(process.cwd())'] };
    const r = await executeCommand(spec, { cwd: tmpDir });
    assert.match(r.stdout, new RegExp(path.basename(tmpDir)));
  });

  it('returns error result when exec not found in PATH', async () => {
    const spec: CommandSpec = { exec: 'definitely-not-a-real-binary-xyz123', args: [] };
    const r = await executeCommand(spec, { cwd: tmpDir });
    assert.equal(r.exitCode, -1);
    assert.match(r.stderr, /not found|ENOENT|spawn/i);
  });
});

describe('parseLegacyCommand — string form deprecation path', () => {
  it('tokenizes a simple command', () => {
    const r = parseLegacyCommand('prisma migrate deploy');
    assert.equal(r.warning?.includes('deprecated'), true);
    assert.equal(r.spec.exec, 'prisma');
    assert.deepEqual(r.spec.args, ['migrate', 'deploy']);
  });

  it('tokenizes with quoted args', () => {
    const r = parseLegacyCommand('echo "hello world"');
    assert.equal(r.spec.exec, 'echo');
    assert.deepEqual(r.spec.args, ['hello world']);
  });

  it('rejects strings containing shell metacharacters', () => {
    assert.throws(() => parseLegacyCommand('foo; rm -rf /'), /shell metachar|forbidden|reject/i);
    assert.throws(() => parseLegacyCommand('foo | bar'), /shell metachar|forbidden|reject/i);
    assert.throws(() => parseLegacyCommand('foo $(bar)'), /shell metachar|forbidden|reject/i);
  });
});

describe('resolveExecutable — PATH resolution + workspace-relative scripts', () => {
  it('resolves a binary present in PATH', () => {
    const r = resolveExecutable('node', tmpDir);
    assert.ok(r.found, `expected node in PATH, got: ${JSON.stringify(r)}`);
    assert.match(r.absolutePath!, /node/);
  });

  it('flags missing binary', () => {
    const r = resolveExecutable('definitely-not-a-real-binary-xyz123', tmpDir);
    assert.equal(r.found, false);
  });

  it('resolves workspace-relative script (./scripts/foo)', () => {
    const scriptPath = path.join(tmpDir, 'scripts', 'foo.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hi');
    fs.chmodSync(scriptPath, 0o755);
    const r = resolveExecutable('./scripts/foo.sh', tmpDir);
    assert.ok(r.found);
    assert.equal(r.absolutePath, scriptPath);
  });
});
