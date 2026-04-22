import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadCachedFindings, saveCachedFindings, filterNewFindings } from '../src/core/persist/findings-cache.ts';
import type { Finding } from '../src/core/findings/types.ts';

function makeFinding(id: string, file: string, line?: number): Finding {
  return {
    id,
    source: 'static-rules',
    severity: 'warning',
    category: 'test',
    file,
    line,
    message: 'test',
    protectedPath: false,
    createdAt: new Date().toISOString(),
  };
}

let tmpDir: string;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cache-')); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('loadCachedFindings', () => {
  it('returns empty array when cache absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-no-cache-'));
    assert.deepEqual(loadCachedFindings(dir), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips findings through save + load', () => {
    const findings = [makeFinding('console-log', 'src/app.ts', 42)];
    saveCachedFindings(tmpDir, findings);
    const loaded = loadCachedFindings(tmpDir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.id, 'console-log');
    assert.equal(loaded[0]!.file, 'src/app.ts');
    assert.equal(loaded[0]!.line, 42);
  });

  it('returns empty array on corrupt cache file', () => {
    const cacheDir = path.join(tmpDir, '.autopilot-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'findings.json'), 'not json', 'utf8');
    assert.deepEqual(loadCachedFindings(tmpDir), []);
  });
});

describe('filterNewFindings', () => {
  it('returns all findings when cache empty', () => {
    const f = makeFinding('A', 'a.ts');
    assert.equal(filterNewFindings([f], []).length, 1);
  });

  it('filters out findings matching id+file+line', () => {
    const cached = [makeFinding('console-log', 'src/app.ts', 10)];
    const current = [
      makeFinding('console-log', 'src/app.ts', 10),  // same — suppress
      makeFinding('console-log', 'src/app.ts', 20),  // different line — keep
      makeFinding('hardcoded-secrets', 'src/app.ts', 10),  // different id — keep
    ];
    const result = filterNewFindings(current, cached);
    assert.equal(result.length, 2);
  });

  it('treats undefined line as distinct from a numbered line', () => {
    const cached = [makeFinding('A', 'a.ts', undefined)];
    const current = [makeFinding('A', 'a.ts', 5)];
    assert.equal(filterNewFindings(current, cached).length, 1);
  });

  it('treats same id+file+no-line as matching', () => {
    const cached = [makeFinding('todo-fixme', 'README.md')];
    const current = [makeFinding('todo-fixme', 'README.md')];
    assert.equal(filterNewFindings(current, cached).length, 0);
  });
});
