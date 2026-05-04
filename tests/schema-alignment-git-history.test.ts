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

  it('default base prefers GITHUB_BASE_REF over HEAD~1 (Bugbot follow-up MEDIUM, PR #44)', () => {
    // Build a fixture repo with main commit + a feature branch with two
    // additional commits. Without env-var awareness, the default HEAD~1
    // points at the previous commit on the feature branch, NOT the merge
    // base — so a multi-commit PR would diff against the wrong version.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-git-history-base-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 'test@example.com');
      git(dir, 'config', 'user.name', 'Test');
      // main commit — file = MAIN-V1
      fs.writeFileSync(path.join(dir, 'file.txt'), 'MAIN-V1\n');
      git(dir, 'add', 'file.txt');
      git(dir, 'commit', '-q', '-m', 'main 1');
      // Simulate origin/main so `origin/main:file.txt` resolves
      git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      // Feature branch with two further commits
      git(dir, 'checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(dir, 'file.txt'), 'FEATURE-V2\n');
      git(dir, 'add', 'file.txt');
      git(dir, 'commit', '-q', '-m', 'feature 2');
      fs.writeFileSync(path.join(dir, 'file.txt'), 'FEATURE-V3\n');
      git(dir, 'add', 'file.txt');
      git(dir, 'commit', '-q', '-m', 'feature 3');

      const savedGh = process.env.GITHUB_BASE_REF;
      try {
        // Without env var: defaults to HEAD~1 → previous feature commit
        // ("FEATURE-V2"), NOT the merge base.
        delete process.env.GITHUB_BASE_REF;
        assert.equal(getPreviousFileContent('file.txt', dir), 'FEATURE-V2\n');
        // With GITHUB_BASE_REF=main: defaults to origin/main → merge-base
        // content ("MAIN-V1") — the correct PR-base for diffing.
        process.env.GITHUB_BASE_REF = 'main';
        assert.equal(getPreviousFileContent('file.txt', dir), 'MAIN-V1\n');
      } finally {
        if (savedGh === undefined) delete process.env.GITHUB_BASE_REF;
        else process.env.GITHUB_BASE_REF = savedGh;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
