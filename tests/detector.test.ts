import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectProject } from '../src/cli/detector.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-detect-'));
}

describe('detectProject', () => {
  it('detects go from go.mod', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/foo\ngo 1.22\n');
    const r = detectProject(dir);
    assert.equal(r.preset, 'go');
    assert.equal(r.testCommand, 'go test ./...');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects rails from Gemfile', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 7'\n");
    const r = detectProject(dir);
    assert.equal(r.preset, 'rails-postgres');
    assert.equal(r.testCommand, 'bundle exec rails test');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects fastapi from requirements.txt', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'fastapi\nuvicorn\n');
    const r = detectProject(dir);
    assert.equal(r.preset, 'python-fastapi');
    assert.equal(r.testCommand, 'pytest');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects t3 from package.json with @trpc/server', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
      dependencies: { '@trpc/server': '^11', 'next': '^15' },
    }));
    const r = detectProject(dir);
    assert.equal(r.preset, 't3');
    assert.equal(r.testCommand, 'vitest run');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects nextjs-supabase from package.json with next + supabase', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'jest' },
      dependencies: { 'next': '^15', '@supabase/supabase-js': '^2' },
    }));
    const r = detectProject(dir);
    assert.equal(r.preset, 'nextjs-supabase');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('falls back to generic on package.json without strong framework signals', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'jest' },
      dependencies: { 'express': '^4' },
    }));
    const r = detectProject(dir);
    assert.equal(r.preset, 'generic');
    assert.equal(r.confidence, 'low');
    fs.rmSync(dir, { recursive: true });
  });

  it('falls back to generic for plain Next.js (no Supabase signals)', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'jest' },
      dependencies: { 'next': '^15' },
    }));
    const r = detectProject(dir);
    // Must not claim "nextjs-supabase" when no Supabase signals — that was the
    // cold-start eval bug that made plain Next.js apps look like hybrid Supabase setups.
    assert.equal(r.preset, 'generic');
    assert.equal(r.confidence, 'low');
    fs.rmSync(dir, { recursive: true });
  });

  it('falls back to generic on empty dir', () => {
    const dir = makeTmp();
    const r = detectProject(dir);
    assert.equal(r.preset, 'generic');
    assert.equal(r.testCommand, 'npm test');
    assert.equal(r.confidence, 'low');
    fs.rmSync(dir, { recursive: true });
  });

  it('ignores npm default test placeholder and falls back to npm test', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
      dependencies: { 'next': '^15', '@supabase/supabase-js': '^2' },
    }));
    const r = detectProject(dir);
    assert.equal(r.testCommand, 'npm test');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects fastapi from pyproject.toml', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.poetry.dependencies]\nfastapi = "*"\n');
    const r = detectProject(dir);
    assert.equal(r.preset, 'python-fastapi');
    assert.equal(r.testCommand, 'pytest');
    assert.equal(r.confidence, 'high');
    fs.rmSync(dir, { recursive: true });
  });

  it('uses custom test script from package.json when not placeholder', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run --reporter=verbose' },
      dependencies: { 'next': '^15' },
    }));
    const r = detectProject(dir);
    assert.equal(r.testCommand, 'vitest run --reporter=verbose');
    fs.rmSync(dir, { recursive: true });
  });
});
