import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findWorkspaces } from '../../src/core/migrate/monorepo.ts';

function mkdir(root: string, rel: string) {
  fs.mkdirSync(path.join(root, rel), { recursive: true });
}
function write(root: string, rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('findWorkspaces', () => {
  it('returns [repoRoot] when no workspace declaration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
    write(dir, 'package.json', JSON.stringify({ name: 'app' }));
    const r = findWorkspaces(dir);
    assert.deepEqual(r, [dir]);
    fs.rmSync(dir, { recursive: true });
  });

  it('reads pnpm-workspace.yaml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
    write(dir, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    mkdir(dir, 'packages/web');
    mkdir(dir, 'packages/api');
    const r = findWorkspaces(dir).map(p => path.basename(p)).sort();
    assert.deepEqual(r, ['api', 'web']);
    fs.rmSync(dir, { recursive: true });
  });

  it('reads package.json#workspaces (array form)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
    write(dir, 'package.json', JSON.stringify({ name: 'root', workspaces: ['apps/*', 'libs/*'] }));
    mkdir(dir, 'apps/web');
    mkdir(dir, 'apps/admin');
    mkdir(dir, 'libs/shared');
    const r = findWorkspaces(dir).map(p => path.basename(p)).sort();
    assert.deepEqual(r, ['admin', 'shared', 'web']);
    fs.rmSync(dir, { recursive: true });
  });

  it('reads package.json#workspaces (object form { packages: [...] })', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
    write(dir, 'package.json', JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }));
    mkdir(dir, 'packages/a');
    const r = findWorkspaces(dir).map(p => path.basename(p));
    assert.deepEqual(r, ['a']);
    fs.rmSync(dir, { recursive: true });
  });

  it('reads nx.json projects', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
    write(dir, 'nx.json', JSON.stringify({
      projects: {
        web: { root: 'apps/web' },
        api: { root: 'apps/api' },
      },
    }));
    mkdir(dir, 'apps/web');
    mkdir(dir, 'apps/api');
    const r = findWorkspaces(dir).map(p => path.basename(p)).sort();
    assert.deepEqual(r, ['api', 'web']);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips non-existent workspace patterns silently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
    write(dir, 'package.json', JSON.stringify({ workspaces: ['nonexistent/*'] }));
    const r = findWorkspaces(dir);
    assert.deepEqual(r, [dir]); // falls back to repo root since no real workspaces
    fs.rmSync(dir, { recursive: true });
  });

  it('does not include packages outside repoRoot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
    write(dir, 'package.json', JSON.stringify({ workspaces: ['../escape/*'] }));
    mkdir(path.dirname(dir), 'escape/evil');
    const r = findWorkspaces(dir);
    // Result must contain only paths under dir
    for (const w of r) {
      assert.ok(w.startsWith(dir), `workspace ${w} escapes repoRoot ${dir}`);
    }
    fs.rmSync(dir, { recursive: true });
    fs.rmSync(path.join(path.dirname(dir), 'escape'), { recursive: true, force: true });
  });
});
