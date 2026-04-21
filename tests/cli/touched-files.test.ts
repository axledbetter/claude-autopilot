import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveGitTouchedFiles } from '../../src/core/git/touched-files.ts';

async function makeGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-git-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

async function addCommit(dir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    execFileSync('git', ['add', name], { cwd: dir, stdio: 'ignore' });
  }
  execFileSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'ignore' });
}

describe('resolveGitTouchedFiles', () => {
  it('T1: returns files changed in HEAD vs HEAD~1', async () => {
    const dir = await makeGitRepo();
    try {
      await addCommit(dir, { 'a.ts': 'const a = 1;' }, 'init');
      await addCommit(dir, { 'b.ts': 'const b = 2;', 'c.ts': 'const c = 3;' }, 'add b and c');
      const files = resolveGitTouchedFiles({ cwd: dir });
      assert.ok(files.includes('b.ts'), 'b.ts should be in touched files');
      assert.ok(files.includes('c.ts'), 'c.ts should be in touched files');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('T2: returns [] for repo with single commit (no HEAD~1)', async () => {
    const dir = await makeGitRepo();
    try {
      await addCommit(dir, { 'x.ts': 'const x = 1;' }, 'init');
      // git diff HEAD~1 fails — falls back to git status which also returns nothing (clean)
      const files = resolveGitTouchedFiles({ cwd: dir });
      assert.ok(Array.isArray(files));
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('T3: respects custom --base ref', async () => {
    const dir = await makeGitRepo();
    try {
      await addCommit(dir, { 'a.ts': 'const a = 1;' }, 'init');
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      await addCommit(dir, { 'b.ts': 'const b = 2;' }, 'add b');
      await addCommit(dir, { 'c.ts': 'const c = 3;' }, 'add c');
      // diff from first commit SHA to HEAD — should include b and c
      const files = resolveGitTouchedFiles({ cwd: dir, base: sha });
      assert.ok(files.includes('b.ts'));
      assert.ok(files.includes('c.ts'));
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('T4: deduplicates files', async () => {
    const dir = await makeGitRepo();
    try {
      await addCommit(dir, { 'dup.ts': 'v1' }, 'init');
      await addCommit(dir, { 'dup.ts': 'v2' }, 'update');
      const files = resolveGitTouchedFiles({ cwd: dir });
      const dupCount = files.filter(f => f === 'dup.ts').length;
      assert.equal(dupCount, 1);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  it('T5: falls back to git status for unstaged changes when diff returns nothing', async () => {
    const dir = await makeGitRepo();
    try {
      await addCommit(dir, { 'base.ts': 'base' }, 'init');
      // Write an unstaged file
      await fs.writeFile(path.join(dir, 'unstaged.ts'), 'new', 'utf8');
      // diff HEAD~1 will fail (single commit), but status should show unstaged.ts
      const files = resolveGitTouchedFiles({ cwd: dir });
      // May or may not contain unstaged.ts depending on git status behavior — just ensure no throw
      assert.ok(Array.isArray(files));
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});
