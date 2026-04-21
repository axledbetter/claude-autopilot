import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveGitTouchedFiles } from '../src/core/git/touched-files.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-touched-'));
}

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.toString()}`);
}

function initRepo(dir: string): void {
  git(['init'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
}

describe('resolveGitTouchedFiles', () => {
  it('returns empty array when nothing changed since last commit', () => {
    const dir = makeTmp();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'init'], dir);
    fs.writeFileSync(path.join(dir, 'next.ts'), 'export {};\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'second'], dir);
    const files = resolveGitTouchedFiles({ cwd: dir, base: 'HEAD' });
    assert.deepEqual(files, []);
    fs.rmSync(dir, { recursive: true });
  });

  it('filters out node_modules/ files', () => {
    const dir = makeTmp();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export {};\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'init'], dir);
    fs.mkdirSync(path.join(dir, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'foo', 'index.js'), '');
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const x = 1;\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'add files'], dir);
    const files = resolveGitTouchedFiles({ cwd: dir });
    assert.ok(!files.some(f => f.startsWith('node_modules/')), `node_modules leaked: ${files}`);
    assert.ok(files.includes('src.ts'), `Expected src.ts: ${files}`);
    fs.rmSync(dir, { recursive: true });
  });

  it('filters out dist/ and build/ files', () => {
    const dir = makeTmp();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export {};\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'init'], dir);
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), '');
    fs.writeFileSync(path.join(dir, 'build', 'app.js'), '');
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const x = 1;\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'add build artifacts'], dir);
    const files = resolveGitTouchedFiles({ cwd: dir });
    assert.ok(!files.some(f => f.startsWith('dist/') || f.startsWith('build/')), `artifacts leaked: ${files}`);
    assert.ok(files.includes('src.ts'));
    fs.rmSync(dir, { recursive: true });
  });

  it('falls back to git status when diff has no parent', () => {
    const dir = makeTmp();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'new.ts'), 'export {};\n');
    git(['add', '.'], dir);
    const files = resolveGitTouchedFiles({ cwd: dir });
    assert.ok(files.includes('new.ts'), `Expected new.ts in fallback results: ${files}`);
    fs.rmSync(dir, { recursive: true });
  });

  it('deduplicates repeated file entries', () => {
    const dir = makeTmp();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'init'], dir);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'modify'], dir);
    const files = resolveGitTouchedFiles({ cwd: dir, base: 'HEAD~1' });
    const count = files.filter(f => f === 'a.ts').length;
    assert.equal(count, 1, `Expected no duplicates, got: ${files}`);
    fs.rmSync(dir, { recursive: true });
  });
});
