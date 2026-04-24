import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('preflight — superpowers skill detection', () => {
  it('reports all skills missing when no plugin dir exists', async () => {
    const { findMissingSuperpowersSkills } = await import('../src/cli/preflight.ts');
    // Isolate under a HOME that has no .claude/plugins
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-empty-home-'));
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-empty-cwd-'));
    process.env.HOME = empty;
    process.chdir(tmpCwd);
    try {
      const missing = findMissingSuperpowersSkills();
      assert.deepEqual(missing.sort(), [
        'subagent-driven-development',
        'using-git-worktrees',
        'writing-plans',
      ]);
    } finally {
      process.env.HOME = savedHome;
      process.chdir(savedCwd);
      fs.rmSync(empty, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('finds skills under home/.claude/plugins/<any>/skills/<name>/SKILL.md', async () => {
    const { findMissingSuperpowersSkills } = await import('../src/cli/preflight.ts');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-home-'));
    const pluginSkills = path.join(home, '.claude', 'plugins', 'some-plugin', 'skills');
    for (const s of ['writing-plans', 'using-git-worktrees', 'subagent-driven-development']) {
      fs.mkdirSync(path.join(pluginSkills, s), { recursive: true });
      fs.writeFileSync(path.join(pluginSkills, s, 'SKILL.md'), '---\nname: ' + s + '\n---\n');
    }
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-home-cwd-'));
    process.env.HOME = home;
    process.chdir(tmpCwd);
    try {
      const missing = findMissingSuperpowersSkills();
      assert.deepEqual(missing, []);
    } finally {
      process.env.HOME = savedHome;
      process.chdir(savedCwd);
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('finds skills nested under plugin cache dirs (e.g. cache/temp_git_*/skills/<name>)', async () => {
    const { findMissingSuperpowersSkills } = await import('../src/cli/preflight.ts');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-home-nested-'));
    // Simulate Claude Code plugin cache layout
    const cachedSkills = path.join(home, '.claude', 'plugins', 'cache', 'temp_git_123', 'skills');
    for (const s of ['writing-plans', 'using-git-worktrees', 'subagent-driven-development']) {
      fs.mkdirSync(path.join(cachedSkills, s), { recursive: true });
      fs.writeFileSync(path.join(cachedSkills, s, 'SKILL.md'), '---\nname: ' + s + '\n---\n');
    }
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-home-nested-cwd-'));
    process.env.HOME = home;
    process.chdir(tmpCwd);
    try {
      const missing = findMissingSuperpowersSkills();
      assert.deepEqual(missing, []);
    } finally {
      process.env.HOME = savedHome;
      process.chdir(savedCwd);
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('reports only the subset missing when some skills are present', async () => {
    const { findMissingSuperpowersSkills } = await import('../src/cli/preflight.ts');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-home-partial-'));
    const skills = path.join(home, '.claude', 'plugins', 'sp', 'skills');
    fs.mkdirSync(path.join(skills, 'writing-plans'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'writing-plans', 'SKILL.md'), '---\nname: writing-plans\n---\n');
    // using-git-worktrees and subagent-driven-development not installed
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-home-partial-cwd-'));
    process.env.HOME = home;
    process.chdir(tmpCwd);
    try {
      const missing = findMissingSuperpowersSkills();
      assert.deepEqual(missing.sort(), ['subagent-driven-development', 'using-git-worktrees']);
    } finally {
      process.env.HOME = savedHome;
      process.chdir(savedCwd);
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
