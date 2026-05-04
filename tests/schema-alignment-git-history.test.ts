// tests/schema-alignment-git-history.test.ts
//
// Pins the base-ref behavior of getPreviousFileContent against the bugbot
// HIGH finding from PR #44: reading from `HEAD` returns the current commit's
// content (identical to the working tree in CI/post-commit), so the diff is
// always empty and no schema entities are emitted. The fix defaults to
// `HEAD~1` and accepts an explicit base override.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getPreviousFileContent } from '../src/core/schema-alignment/git-history.ts';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
}

function makeRepoWithTwoCommits(): { dir: string; tearDown: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-git-history-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  // Commit 1: file = "ONE"
  fs.writeFileSync(path.join(dir, 'file.txt'), 'ONE\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-q', '-m', 'commit 1');
  // Commit 2: file = "TWO"
  fs.writeFileSync(path.join(dir, 'file.txt'), 'TWO\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-q', '-m', 'commit 2');
  return {
    dir,
    tearDown: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('getPreviousFileContent — base ref', () => {
  it('defaults to HEAD~1 (not HEAD) so post-commit contexts return the prior version', () => {
    const { dir, tearDown } = makeRepoWithTwoCommits();
    try {
      // Default base: should return commit-1 content ("ONE"), NOT current ("TWO").
      // Reading HEAD would return "TWO" — same as the working tree — and the
      // diff would be empty. That's the bug.
      const prev = getPreviousFileContent('file.txt', dir);
      assert.equal(prev, 'ONE\n');
    } finally {
      tearDown();
    }
  });

  it('accepts an explicit base override (e.g. main, a SHA, GITHUB_BASE_REF resolution)', () => {
    const { dir, tearDown } = makeRepoWithTwoCommits();
    try {
      // Explicitly pass HEAD~1 — same content as the default.
      const prev = getPreviousFileContent('file.txt', dir, 'HEAD~1');
      assert.equal(prev, 'ONE\n');
      // And HEAD reads the current commit (would be the bug if we used it as default)
      const current = getPreviousFileContent('file.txt', dir, 'HEAD');
      assert.equal(current, 'TWO\n');
    } finally {
      tearDown();
    }
  });

  it('returns null when the ref does not resolve (e.g. first-commit repo with no HEAD~1)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-git-history-empty-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 'test@example.com');
      git(dir, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(dir, 'file.txt'), 'only\n');
      git(dir, 'add', 'file.txt');
      git(dir, 'commit', '-q', '-m', 'first commit');
      // No HEAD~1 exists — expect null, not a throw.
      const prev = getPreviousFileContent('file.txt', dir);
      assert.equal(prev, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
