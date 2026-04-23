import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWorkspace, assertInWorkspace } from '../../src/core/mcp/workspace.ts';

describe('resolveWorkspace', () => {
  it('resolves process.cwd() when no cwd given', () => {
    const result = resolveWorkspace(undefined);
    assert.equal(result, fs.realpathSync(process.cwd()));
  });

  it('resolves a given directory to its realpath', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    assert.equal(resolveWorkspace(tmp), fs.realpathSync(tmp));
    fs.rmdirSync(tmp);
  });
});

describe('assertInWorkspace', () => {
  let tmp: string;

  it('returns realpath for a file inside workspace', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, '');
    const result = assertInWorkspace(tmp, 'foo.ts');
    assert.equal(result, fs.realpathSync(file));
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws for path traversal outside workspace', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    assert.throws(
      () => assertInWorkspace(tmp, '../../etc/passwd'),
      /outside workspace/,
    );
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws for absolute path outside workspace', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    assert.throws(
      () => assertInWorkspace(tmp, '/etc/passwd'),
      /outside workspace/,
    );
    fs.rmSync(tmp, { recursive: true });
  });

  it('allows absolute path inside workspace', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, '');
    const result = assertInWorkspace(tmp, file);
    assert.equal(result, fs.realpathSync(file));
    fs.rmSync(tmp, { recursive: true });
  });
});
